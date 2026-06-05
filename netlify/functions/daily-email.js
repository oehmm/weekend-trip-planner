/**
 * Netlify Scheduled Function – läuft täglich um 07:00 Uhr
 * Schickt die Wochenend-Planung an boettinger.oehm@gmail.com
 *
 * Cron: "0 7 * * *"  (täglich 07:00 UTC)
 *
 * Benötigt env vars:
 *   ANTHROPIC_API_KEY
 *   RESEND_API_KEY      → https://resend.com (kostenlos: 3000 E-Mails/Monat)
 */

import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const RECIPIENT = "boettinger.oehm@gmail.com";

// Standardeinstellungen für den täglichen Report
const DEFAULTS = {
  origin: "MUC",
  flightBudget: 300,
  hotelBudget: 120,
  hotelStars: 3,
  hotelLocation: ["Stadtzentrum"],
  departureTime: "nachmittags",
  returnTime: "abends",
  interests: "Kultur, gutes Essen, Architektur, wenig Massentourismus",
};

// ── Hilfsfunktionen (inline, damit die Function eigenständig ist) ──

function getNext4Weekends() {
  const weekends = [];
  const today = new Date();
  const day = today.getDay();
  const daysToFriday = day <= 5 ? (5 - day) || 7 : 6;
  let friday = new Date(today);
  friday.setDate(today.getDate() + daysToFriday);
  for (let i = 0; i < 4; i++) {
    const sunday = new Date(friday);
    sunday.setDate(friday.getDate() + 2);
    weekends.push({
      friday: friday.toISOString().split("T")[0],
      sunday: sunday.toISOString().split("T")[0],
      label: friday.toLocaleDateString("de-DE", { day: "2-digit", month: "long" }),
    });
    friday = new Date(friday);
    friday.setDate(friday.getDate() + 7);
  }
  return weekends;
}

async function planWeekend(weekend) {
  const { origin, flightBudget, hotelBudget, hotelStars, hotelLocation, departureTime, returnTime, interests } = DEFAULTS;

  const messages = [{ role: "user", content: `Plane ein Wochenende vom ${weekend.friday} bis ${weekend.sunday} ab ${origin}. Interessen: ${interests}` }];
  const systemPrompt =
    `Du bist ein Reiseplaner. Antworte kompakt auf Deutsch (max. 300 Wörter).\n` +
    `Budget: Flug max. ${flightBudget}€, Hotel max. ${hotelBudget}€/Nacht (mind. ${hotelStars}★, ${hotelLocation.join('/')}).\n` +
    `Abflug Freitag ${departureTime}, Rückflug Sonntag ${returnTime}.\n` +
    `Empfehle eine Stadt mit: Begründung, Fluginfo, 2 Restaurants, 1 Highlight, 1 Geheimtipp.`;

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 600,
    system: systemPrompt,
    messages,
  });
  return response.content[0]?.text || "";
}

function buildEmailHtml(plans) {
  const today = new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const cards = plans.map(({ weekend, result }) => `
    <tr>
      <td style="padding: 0 0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #d1cdc5;">
          <tr>
            <td style="padding: 12px 20px; border-bottom: 1px solid #d1cdc5; background: #eee9e0;">
              <span style="font-family: Georgia, serif; font-style: italic; font-size: 14px; color: #1A1A1A;">
                Wochenende ${weekend.label}
              </span>
              <span style="font-size: 11px; color: #9ca3af; margin-left: 12px; letter-spacing: 0.1em; text-transform: uppercase;">
                Fr ${weekend.friday} – So ${weekend.sunday}
              </span>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px; font-family: Arial, sans-serif; font-size: 13px; line-height: 1.7; color: #333; white-space: pre-wrap;">${result || "Keine Daten verfügbar."}</td>
          </tr>
        </table>
      </td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F5F2EB;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F2EB;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0">
          <!-- Header -->
          <tr>
            <td style="padding: 0 0 24px; border-bottom: 1px solid #1A1A1A; margin-bottom: 32px;">
              <span style="font-size: 10px; font-weight: bold; letter-spacing: 0.2em; text-transform: uppercase; color: #9ca3af;">Travel v.01</span>
              <br>
              <span style="font-family: Georgia, serif; font-style: italic; font-size: 28px; color: #1A1A1A;">Weekend Trip Planner</span>
              <br>
              <span style="font-size: 11px; color: #9ca3af; letter-spacing: 0.1em;">${today}</span>
            </td>
          </tr>
          <!-- Spacer -->
          <tr><td style="height:24px;"></td></tr>
          <!-- Plans -->
          ${cards}
          <!-- Footer -->
          <tr>
            <td style="padding-top: 16px; border-top: 1px solid #d1cdc5; font-size: 10px; color: #9ca3af; letter-spacing: 0.1em; text-transform: uppercase;">
              Täglich generiert · Weekend Trip Planner · Ab ${DEFAULTS.origin}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Scheduled Handler ──
export const handler = async () => {
  try {
    const weekends = getNext4Weekends();

    // Alle 4 parallel planen
    const plans = await Promise.all(
      weekends.map((weekend) =>
        planWeekend(weekend)
          .then((result) => ({ weekend, result }))
          .catch((err) => ({ weekend, result: `Fehler: ${err.message}` }))
      )
    );

    const html = buildEmailHtml(plans);
    const today = new Date().toLocaleDateString("de-DE", { day: "numeric", month: "long" });

    await resend.emails.send({
      from: "Weekend Planner <onboarding@resend.dev>",
      to: RECIPIENT,
      subject: `✈ Deine 4 Wochenenden – ${today}`,
      html,
    });

    console.log(`Daily email sent to ${RECIPIENT}`);
    return { statusCode: 200 };
  } catch (err) {
    console.error("Daily email failed:", err.message);
    return { statusCode: 500, body: err.message };
  }
};

// Netlify Scheduled Function config
export const config = {
  schedule: "0 7 * * *",
};
