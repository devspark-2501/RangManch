import crypto from "crypto";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import Exhibition from "@/models/Exhibition";
import Booking from "@/models/Booking";
import Payment from "@/models/Payment";

// Statuses that count toward a category's capacity
const CAPACITY_STATUSES = ["Pending", "Confirmed"];

export async function POST(req) {
  try {
    await connectDB();

    const body = await req.json();
    const {
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      vendorName,
      businessName,
      mobile,
      email,
      category,
      products,
      social,
      terms,
      extraTableCount,
      exhibitionId,
    } = body;

    // ── Validate required fields ─────────────────────────────────────────
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return Response.json(
        { success: false, message: "Missing Razorpay payment fields." },
        { status: 400 }
      );
    }
    if (!exhibitionId) {
      return Response.json(
        { success: false, message: "Exhibition ID is required." },
        { status: 400 }
      );
    }
    if (!category?.trim()) {
      return Response.json(
        { success: false, message: "Category is required." },
        { status: 400 }
      );
    }

    // ── Verify Razorpay signature ────────────────────────────────────────
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (expectedSignature !== razorpaySignature) {
      return Response.json(
        { success: false, message: "Payment verification failed. Invalid signature." },
        { status: 400 }
      );
    }

    // ── Idempotency: webhook may have already processed this order ───────
    const existingPayment = await Payment.findOne({ razorpayOrderId });
    if (existingPayment) {
      if (existingPayment.bookingId) {
        const existingBooking = await Booking.findById(existingPayment.bookingId).lean();
        return Response.json(
          { success: true, booking: existingBooking, payment: existingPayment, alreadyProcessed: true },
          { status: 200 }
        );
      }
      // Payment exists but no booking yet — fall through, unique index protects us
    }

    // ── Fetch exhibition (outside transaction — read-only, no race risk) ─
    const exhibition = await Exhibition.findById(exhibitionId).lean();
    if (!exhibition) {
      return Response.json(
        { success: false, message: "Exhibition not found." },
        { status: 404 }
      );
    }

    const categoryDef = (exhibition.categoryLimits ?? []).find(
      (c) => c.category === category
    );
    if (!categoryDef) {
      return Response.json(
        { success: false, message: "Category is not valid for this exhibition." },
        { status: 400 }
      );
    }

    // ── Server-side pricing ──────────────────────────────────────────────
    const rawCount       = Number(extraTableCount);
    const safeCount      = Number.isFinite(rawCount) && rawCount >= 0 ? Math.floor(rawCount) : 0;
    const entryCost      = exhibition.entryCost      ?? 0;
    const extraTableCost = exhibition.extraTableCost ?? 0;
    const totalAmount    = entryCost + extraTableCost * safeCount;

    // ── Atomic capacity check + booking creation (transaction) ───────────
    //
    // ROOT CAUSE OF THE BUG:
    //   Without a transaction, two simultaneous requests both run
    //   countDocuments, both see count < maxSlots, both pass, both write —
    //   resulting in more bookings than the limit allows.
    //
    // FIX:
    //   Wrapping countDocuments + Booking.create inside a transaction means
    //   MongoDB holds a document-level write lock for that category/exhibition
    //   combination. The second request's countDocuments will block (or see
    //   the first write) and correctly hit the limit.
    //
    // REQUIREMENT: MongoDB replica set (Atlas always qualifies; local dev
    //   needs --replSet or use mongodb-memory-server with replSet option).
    //
    const session = await mongoose.startSession();

    try {
      let booking;
      let payment;

      await session.withTransaction(async () => {
        // ── Capacity check — runs inside the transaction ─────────────────
        const existingCount = await Booking.countDocuments({
          exhibitionId: exhibition._id,
          category,
          status: { $in: CAPACITY_STATUSES },
        }).session(session);

        if (existingCount >= categoryDef.maxSlots) {
          // Abort the transaction — no booking, no payment written
          throw Object.assign(
            new Error(
              `This category is full. Please contact us for a refund. Reference: ${razorpayPaymentId}`
            ),
            { isFull: true }
          );
        }

        // ── Create Booking ───────────────────────────────────────────────
        // create() with a session requires array syntax
        const [newBooking] = await Booking.create(
          [
            {
              vendorName,
              businessName,
              mobile,
              email,
              category,
              products:           products   ?? "",
              social:             social     ?? "",
              terms:              terms      ?? false,
              status:             "Confirmed",
              exhibitionId:       exhibition._id,
              exhibitionTitle:    exhibition.title,
              exhibitionDate:     exhibition.date     ?? "",
              exhibitionLocation: exhibition.location ?? "",
              entryCost,
              extraTableCost,
              extraTableCount:    safeCount,
              totalAmount,
            },
          ],
          { session }
        );

        // ── Create Payment ───────────────────────────────────────────────
        const [newPayment] = await Payment.create(
          [
            {
              bookingId:         newBooking._id,
              exhibitionId:      exhibition._id,
              vendorName,
              email,
              mobile,
              amount:            totalAmount,
              razorpayOrderId,
              razorpayPaymentId,
              razorpaySignature,
              paymentStatus:     "Paid",
            },
          ],
          { session }
        );

        booking = newBooking;
        payment = newPayment;
      });

      return Response.json(
        { success: true, booking, payment },
        { status: 201 }
      );
    } catch (err) {
      // ── Category full (thrown inside transaction) ────────────────────
      if (err.isFull) {
        return Response.json(
          { success: false, message: err.message },
          { status: 400 }
        );
      }

      // ── Webhook beat us to it (duplicate key on razorpayOrderId) ─────
      if (err.code === 11000) {
        const winningPayment = await Payment.findOne({ razorpayOrderId });
        const winningBooking = winningPayment?.bookingId
          ? await Booking.findById(winningPayment.bookingId).lean()
          : null;

        return Response.json(
          { success: true, booking: winningBooking, payment: winningPayment, alreadyProcessed: true },
          { status: 200 }
        );
      }

      throw err;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("POST /api/razorpay/verify-payment error:", error);
    return Response.json(
      { success: false, message: error.message },
      { status: 500 }
    );
  }
}