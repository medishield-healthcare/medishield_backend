const resendImport = require("resend");
const { Resend } = resendImport;
require("dotenv").config();
const resend = new Resend(process.env.RESEND_API);

async function sendResendEmail(
    to,
    subject,
    html
) {
    const { data, error } = await resend.emails.send({
        from: 'MediShield-No-reply <medishield@darkinc.tech>',
        to: [to],
        subject: subject,
        html: html,
    });

    if (error) {
        return console.error({ error });
    }

    console.log({ data });
    return data;
};

module.exports = { sendResendEmail }