import { createContext, useContext } from "react";
import type { AppConfig } from "./types.js";

/** Effective server configuration, loaded once after sign-in. */
export const ConfigContext = createContext<AppConfig | null>(null);

export function useConfig(): AppConfig | null {
  return useContext(ConfigContext);
}
