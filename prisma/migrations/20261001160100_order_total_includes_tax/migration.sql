-- Total now also includes GST on the delivery charge and the passed-on gateway fee (online payment).
ALTER TABLE "Order" DROP CONSTRAINT "Order_amounts_nonneg";
ALTER TABLE "Order" ADD CONSTRAINT "Order_amounts_nonneg" CHECK (
  "subtotal" >= 0 AND "deliveryCharge" >= 0 AND "deliveryTax" >= 0 AND "paymentFee" >= 0 AND "paidOnline" >= 0
  AND "total" = "subtotal" + "deliveryCharge" + "deliveryTax" + "paymentFee"
);
