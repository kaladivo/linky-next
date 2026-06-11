/**
 * Runtime environment for the app, derived from the build-time APP_ENV
 * profile baked into the Expo config (`extra.appEnv` in app.config.ts).
 *
 * Both values are decoded through @linky/core's Effect Schemas at startup:
 * an invalid profile or a spec violation (e.g. a mainnet mint in a
 * non-production build) crashes immediately instead of shipping a misbuilt
 * app. Endpoint values come exclusively from this module — never inline
 * literals elsewhere.
 */
import { decodeAppProfile, environmentForProfile, type EnvironmentConfig } from "@linky/core";
import Constants from "expo-constants";

export const appProfile = decodeAppProfile(Constants.expoConfig?.extra?.["appEnv"]);

export const environment: EnvironmentConfig = environmentForProfile(appProfile);
