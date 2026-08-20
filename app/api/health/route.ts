import { jsonResponse } from "@/lib/server/http";

export async function GET() {
  return jsonResponse({
    ok: true,
    ai: {
      configured: Boolean(process.env.DEEPSEEK_API_KEY),
      provider: "DeepSeek",
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    },
    transcription: {
      configured: Boolean(process.env.TRANSCRIPTION_API_KEY && process.env.TRANSCRIPTION_BASE_URL),
    },
    time: new Date().toISOString(),
  });
}
