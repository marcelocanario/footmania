import "dotenv/config";

export const PORT = Number(process.env.PORT ?? 3001);
export const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30);
export const COOKIE_NAME = "fm_session";
