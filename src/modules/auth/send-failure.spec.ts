import { sendFailureMessage } from "./phone-otp.service";

describe("code not sent: what the customer is told", () => {
  it("not on WhatsApp asks for their WhatsApp number", () => {
    expect(
      sendFailureMessage(
        "whatsapp-web: This number is not on WhatsApp.",
        "whatsapp",
      ),
    ).toBe(
      "This number is not on WhatsApp. Enter the mobile number you use on WhatsApp.",
    );
  });
  it("a frozen or busy WhatsApp asks to try again", () => {
    const msg = sendFailureMessage(
      "whatsapp-web: Runtime.callFunctionOn timed out.",
      "whatsapp",
    );
    expect(msg).toContain("WhatsApp code");
    expect(msg).toContain("try again in a minute");
    expect(sendFailureMessage(null, "sms")).toContain("SMS");
  });
});
