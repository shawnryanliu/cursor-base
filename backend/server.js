require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.MINIMAX_API_KEY) {
  console.error("Error: MINIMAX_API_KEY is not set in .env");
  process.exit(1);
}

const client = new Anthropic({
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: "https://api.minimax.io/anthropic",
});

app.use(cors());
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
    return res.status(400).json({ error: "prompt is required" });
  }

  // Use SSE to stream the response to the frontend
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = client.messages.stream({
      model: "MiniMax-M2.5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt.trim() }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("MiniMax API error:", err.message);
    res.write(`data: ${JSON.stringify({ error: "API call failed" })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
