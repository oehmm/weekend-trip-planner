import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Flugsuche via SerpAPI
// ---------------------------------------------------------------------------
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
      const returnLegs = f.layovers ? [] : (f.return_flights?.flights || []);
      return {
        preis_eur: f.price || "?",
        abflug: legs[0]?.departure_airport?.time || "",
        ankunft: legs[legs.length - 1]?.arrival_airport?.time || "",
        rueckflug_abflug: returnLegs[0]?.departure_airport?.time || "",
        ankunft_zuhause: returnLegs[returnLegs.length - 1]?.arrival_airport?.time || "",
        airline: legs[0]?.airline || "",
        dauer_min: f.total_duration || "",
        im_budget: f.price <= maxBudget,
      };
    });
    return { flüge: results, destination };
  } catch {
    return mockFlights(origin, destination, outboundDate, returnDate);
  }
}

function mockFlights(origin, destination, outboundDate, returnDate) {
  return {
    flüge: [
      {
        preis_eur: Math.floor(Math.random() * 150) + 120,
        abflug: `${outboundDate}T15:30:00`,
        ankunft: `${outboundDate}T17:45:00`,
        rueckflug_abflug: `${returnDate}T19:00:00`,
        ankunft_zuhause: `${returnDate}T21:15:00`,
        airline: ["EW", "FR", "LH"][Math.floor(Math.random() * 3)],
        dauer_min: 135,
        im_budget: true,
      },
    ],
    destination,
    hinweis: "Simulierte Daten – SerpAPI Key für echte Preise hinterlegen",
  };
}

// ---------------------------------------------------------------------------
// Stadt-Highlights via Claude Sub-Agent
// ---------------------------------------------------------------------------
async function getCityHighlights(city, weekendDate, interests, hotelBudget, hotelStars, hotelLocation) {
  const locationStr = Array.isArray(hotelLocation) ? hotelLocation.join(', ') : (hotelLocation || 'Stadtzentrum');
  const resp = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1500,
    system:
      "Du bist ein erfahrener Reiseexperte. Gib konkrete, persönliche Empfehlungen – keine Touristenfloskeln. Antworte auf Deutsch in Markdown.",
    messages: [
      {
        role: "user",
        content:
          `Reiseempfehlungen für **${city}**, Wochenende ${weekendDate}.\n` +
          `Interessen: ${interests || "Kultur, Essen, Architektur"}\n` +
          `Hotelbudget: max. ${hotelBudget}€/Nacht, mind. ${hotelStars || 3} Sterne, Lage: ${locationStr}\n\n` +
          `## Warum genau jetzt?\n` +
          `## Top 3 Sehenswürdigkeiten\n` +
          `## Restaurants (3 Empfehlungen mit Preisklasse €/€€/€€€)\n` +
          `## Events & Veranstaltungen\n` +
          `## Geheimtipp\n` +
          `## Hotel-Empfehlung (${hotelStars || 3}★+, ${locationStr}, max. ${hotelBudget}€/Nacht)`,
      },
    ],
  });
  return resp.content[0].text;
}

// ---------------------------------------------------------------------------
// Nächste 4 Wochenenden berechnen
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

// ---------------------------------------------------------------------------
// Tool-Definitionen
// ---------------------------------------------------------------------------
function buildTools(flightBudget, hotelBudget) {
  return [
    {
      name: "search_weekend_flights",
      description:
        "Sucht Flüge für einen Wochenendtrip. Freitag ab 13:00 Uhr, Sonntag Rückflug bis 22:00 Uhr.",
      input_schema: {
        type: "object",
        properties: {
          destination_iata: { type: "string", description: "IATA-Code, z.B. LIS, BCN, OPO" },
          friday_date: { type: "string", description: "YYYY-MM-DD" },
          sunday_date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["destination_iata", "friday_date", "sunday_date"],
      },
    },
    {
      name: "get_city_highlights",
      description: "Detaillierte Reiseinfos: Sehenswürdigkeiten, Restaurants, Events, Geheimtipps.",
      input_schema: {
        type: "object",
        properties: {
          city: { type: "string" },
          weekend_date: { type: "string", description: "YYYY-MM-DD des Freitags" },
          interests: { type: "string" },
        },
        required: ["city", "weekend_date"],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Orchestrator Agent
// ---------------------------------------------------------------------------
const DEP_TIME_MAP = { morgens: "06:00–11:00", nachmittags: "12:00–17:00", abends: "18:00–23:00" };
const RET_TIME_MAP = { nachmittags: "12:00–17:00", abends: "17:00–21:00", nacht: "21:00–00:00" };

async function runAgent({ weekend, flightBudget, hotelBudget, interests, origin, departureTime, returnTime, hotelStars, hotelLocation }) {
  const tools = buildTools(flightBudget, hotelBudget);
  const depWindow = DEP_TIME_MAP[departureTime] || "12:00–17:00";
  const retWindow = RET_TIME_MAP[returnTime] || "17:00–21:00";
  const systemPrompt =
    `Du bist ein persönlicher Reiseplaner.\n` +
    `Wochenende: Freitag ${weekend.friday} bis Sonntag ${weekend.sunday}.\n` +
    `Abflughafen: ${origin}\n` +
    `Flugbudget: max. ${flightBudget}€ (hin + zurück)\n` +
    `Gewünschte Abflugzeit Freitag: ${depWindow} Uhr\n` +
    `Gewünschte Rückflugzeit Sonntag: ${retWindow} Uhr\n` +
    `Hotelbudget: max. ${hotelBudget}€/Nacht, mind. ${hotelStars || 3} Sterne\n` +
    `Hotel-Lage: ${Array.isArray(hotelLocation) ? hotelLocation.join(', ') : 'Stadtzentrum'}\n\n` +
    `Aufgabe:\n` +
    `1. Schlage 2 passende europäische Städte vor\n` +
    `2. Suche Flüge für beide Städte (bevorzuge Abflüge in den gewünschten Zeitfenstern)\n` +
    `3. Hole Stadtinfos für die beste Option\n` +
    `4. Gib eine klare Empfehlung mit Begründung auf Deutsch`;

  const messages = [
    {
      role: "user",
      content: `Plane mein Wochenende vom ${weekend.friday} bis ${weekend.sunday}. Interessen: ${interests || "Kultur, gutes Essen, Architektur, wenig Massentourismus"}`,
    },
  ];

  let iterations = 0;
  while (iterations < 8) {
    iterations++;
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 3000,
      system: systemPrompt,
      tools,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      return response.content.find((b) => b.type === "text")?.text || "";
    }

    if (response.stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        let result = "";
        if (block.name === "search_weekend_flights") {
          const data = await searchFlights(
            origin,
            block.input.destination_iata,
            block.input.friday_date,
            block.input.sunday_date,
            flightBudget
          );
          result = JSON.stringify(data);
        } else if (block.name === "get_city_highlights") {
          result = await getCityHighlights(
            block.input.city,
            block.input.weekend_date,
            block.input.interests,
            hotelBudget,
            hotelStars,
            hotelLocation
          );
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }
  }
  return "Planung konnte nicht abgeschlossen werden.";
}

// ---------------------------------------------------------------------------
// Netlify Handler
// ---------------------------------------------------------------------------
export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = JSON.parse(event.body);
    const {
      flightBudget = 300,
      hotelBudget = 150,
      interests = "",
      origin = "MUC",
      departureTime = "nachmittags",
      returnTime = "abends",
      hotelStars = 3,
      hotelLocation = ["Stadtzentrum"],
    } = body;

    const weekends = getNext4Weekends();

    // Alle 4 Wochenenden parallel planen
    const plans = await Promise.all(
      weekends.map((weekend) =>
        runAgent({ weekend, flightBudget, hotelBudget, interests, origin, departureTime, returnTime, hotelStars, hotelLocation })
          .then((result) => ({ weekend, result, error: null }))
          .catch((err) => ({ weekend, result: null, error: err.message }))
      )
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ plans }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
