import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
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

async function searchFlights(origin, destination, outboundDate, returnDate, maxBudget) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return mockFlights(origin, destination, outboundDate, returnDate);
  const params = new URLSearchParams({
    engine: "google_flights",
    departure_id: origin,
    arrival_id: destination,
    outbound_date: outboundDate,
    return_date: returnDate,
    adults: "1",
    currency: "EUR",
    hl: "de",
    api_key: apiKey,
  });
  try {
    const resp = await fetch(`https://serpapi.com/search?${params}`);
    if (!resp.ok) return mockFlights(origin, destination, outboundDate, returnDate);
    const data = await resp.json();
    const all = [...(data.best_flights || []), ...(data.other_flights || [])];
    const results = all.slice(0, 3).map((f) => {
      const legs = f.flights || [];
      const returnLegs = f.return_flights?.flights || [];
      return {
        preis_eur: f.price || "?",
        abflug: legs[0]?.departure_airport?.time || "",
        ankunft: legs[legs.length - 1]?.arrival_airport?.time || "",
        rueckflug_abflug: returnLegs[0]?.departure_airport?.time || "",
        airline: legs[0]?.airline || "",
        im_budget: f.price <= maxBudget,
      };
    });
    return { flüge: results.length ? results : mockFlights(origin, destination, outboundDate, returnDate).flüge, destination };
  } catch {
    return mockFlights(origin, destination, outboundDate, returnDate);
  }
}

function mockFlights(origin, destination, outboundDate, returnDate) {
  return {
    flüge: [{
      preis_eur: Math.floor(Math.random() * 150) + 120,
      abflug: `${outboundDate}T15:30:00`,
      ankunft: `${outboundDate}T17:45:00`,
      rueckflug_abflug: `${returnDate}T19:00:00`,
      airline: ["EW", "FR", "LH"][Math.floor(Math.random() * 3)],
      im_budget: true,
    }],
    destination,
    hinweis: "Simulierte Daten",
  };
}

const DEP_TIME_MAP = { morgens: "06:00–11:00", nachmittags: "12:00–17:00", abends: "18:00–23:00" };
const RET_TIME_MAP = { nachmittags: "12:00–17:00", abends: "17:00–21:00", nacht: "21:00–00:00" };

async function planWeekend({ weekend, flightBudget, hotelBudget, interests, origin, departureTime, returnTime, hotelStars, hotelLocation }) {
  const depWindow = DEP_TIME_MAP[departureTime] || "12:00–17:00";
  const retWindow = RET_TIME_MAP[returnTime] || "17:00–21:00";
  const locationStr = Array.isArray(hotelLocation) ? hotelLocation.join(", ") : "Stadtzentrum";

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 900,
    system:
      `Du bist ein erfahrener Reiseplaner. Antworte präzise auf Deutsch in Markdown.\n` +
      `Abflughafen: ${origin}. Flugbudget: max. ${flightBudget}€ hin+zurück.\n` +
      `Abflugzeit Fr: ${depWindow} Uhr. Rückflug So: ${retWindow} Uhr.\n` +
      `Hotel: max. ${hotelBudget}€/Nacht, mind. ${hotelStars || 3}★, Lage: ${locationStr}.\n` +
      `Nutze dein Wissen über typische Flugpreise und Routen ab ${origin}.`,
    messages: [{
      role: "user",
      content:
        `Empfehle mir eine europäische Stadt für das Wochenende Fr ${weekend.friday} – So ${weekend.sunday}.\n` +
        `Interessen: ${interests || "Kultur, gutes Essen, Architektur"}.\n\n` +
        `Antworte in genau dieser Struktur:\n` +
        `# [Stadtname]\n` +
        `## Warum genau jetzt?\n` +
        `## Flug (typische Preise & Zeiten ab ${origin})\n` +
        `## Hotel-Empfehlung (${hotelStars || 3}★+, ${locationStr}, ~${hotelBudget}€/Nacht)\n` +
        `## 3 Restaurants\n` +
        `## Top-Highlight & Geheimtipp`,
    }],
  });

  return response.content[0]?.text || "";
}

// ---------------------------------------------------------------------------
// Netlify Handler mit Streaming (Server-Sent Events)
// ---------------------------------------------------------------------------
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const body = JSON.parse(event.body || "{}");
  const {
    flightBudget = 300, hotelBudget = 120, interests = "",
    origin = "MUC", departureTime = "nachmittags", returnTime = "abends",
    hotelStars = 3, hotelLocation = ["Stadtzentrum"],
  } = body;

  const weekends = getNext4Weekends();

  // Alle 4 parallel planen
  const results = await Promise.allSettled(
    weekends.map((weekend) =>
      planWeekend({ weekend, flightBudget, hotelBudget, interests, origin, departureTime, returnTime, hotelStars, hotelLocation })
    )
  );

  const plans = weekends.map((weekend, i) => ({
    weekend,
    result: results[i].status === "fulfilled" ? results[i].value : null,
    error: results[i].status === "rejected" ? results[i].reason?.message : null,
  }));

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({ plans }),
  };
};
