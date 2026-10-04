import Razorpay from "razorpay";
import { connectDB } from "@/lib/mongodb";
import Exhibition from "@/models/Exhibition";
import Booking from "@/models/Booking";

// Statuses that count toward a category's capacity
const CAPACITY_STATUSES = ["Pending", "Confirmed"];

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

export async function POST(req) {
  try {
    await connectDB();

    const body = await req.json();
    const {
      exhibitionId, category, extraTableCount,
      vendorName, businessName, mobile, email, products, social,
    } = body;

    // ── Validate ─────────────────────────────────────────────────────────
    if (!exhibitionId) {
      return Response.json(
        { success: false, message: "Please select an exhibition." },
        { status: 400 }
      );
    }
    if (!category?.trim()) {
      return Response.json(
        { success: false, message: "Please select a product category." },
        { status: 400 }
      );
    }

    // ── Fetch exhibition ─────────────────────────────────────────────────
    const exhibition = await Exhibition.findById(exhibitionId).lean();
    if (!exhibition) {
      return Response.json(
        { success: false, message: "Exhibition not found." },
        { status: 404 }
      );
    }
    if (exhibition.status !== "open") {
      return Response.json(
        { success: false, message: "This exhibition is not open for bookings." },
        { status: 400 }
      );
    }

    // ── Validate category against exhibition's categoryLimits ────────────
    const categoryDef = (exhibition.categoryLimits ?? []).find(
      (c) => c.category === category
    );
    if (!categoryDef) {
      return Response.json(
        { success: false, message: "Selected category is not valid for this exhibition." },
        { status: 400 }
      );
    }

    // ── Pre-flight capacity check (UX only — NOT the enforcement gate) ───
    //
    // This check is intentionally non-atomic: it's a fast, user-friendly
    // early exit so we don't charge someone for a full category. The real
    // atomic enforcement happens inside a MongoDB transaction in
    // /api/razorpay/verify-payment — that is the only check that matters
    // for correctness. Do NOT add a transaction here; creating a Razorpay
    // order does not write anything to our DB so there is nothing to roll
    // back, and locking here would not prevent the race anyway.
    //
    const existingCount = await Booking.countDocuments({
      exhibitionId: exhibition._id,
      category,
      status: { $in: CAPACITY_STATUSES },
    });
    if (existingCount >= categoryDef.maxSlots) {
      return Response.json(
        { success: false, message: "This category is already full for the selected exhibition." },
        { status: 400 }
      );
    }

    // ── Server-side pricing ──────────────────────────────────────────────
    const rawCount        = Number(extraTableCount);
    const safeCount       = Number.isFinite(rawCount) && rawCount >= 0 ? Math.floor(rawCount) : 0;
    const entryCost       = exhibition.entryCost      ?? 0;
    const extraTableCost  = exhibition.extraTableCost ?? 0;
    const totalAmount     = entryCost + extraTableCost * safeCount;

    const amountInPaise = totalAmount * 100;
    if (amountInPaise < 100) {
      return Response.json(
        { success: false, message: "Amount must be at least ₹1." },
        { status: 400 }
      );
    }

    // ── Create Razorpay order ────────────────────────────────────────────
    const order = await razorpay.orders.create({
      amount:   amountInPaise,
      currency: "INR",
      notes: {
        exhibitionId:    exhibition._id.toString(),
        exhibitionTitle: exhibition.title,
        category,
        extraTableCount: String(safeCount),
        vendorName:      vendorName   ?? "",
        businessName:    businessName ?? "",
        mobile:          mobile       ?? "",
        email:           email        ?? "",
        products:        (products ?? "").slice(0, 250),
        social:          (social   ?? "").slice(0, 250),
      },
    });

    return Response.json({
      success:         true,
      orderId:         order.id,
      amount:          totalAmount,
      amountPaise:     amountInPaise,
      currency:        "INR",
      entryCost,
      extraTableCost,
      extraTableCount: safeCount,
    });
  } catch (error) {
    console.error("POST /api/razorpay/create-order error:", error);
    return Response.json(
      { success: false, message: error.message },
      { status: 500 }
    );
  }
}