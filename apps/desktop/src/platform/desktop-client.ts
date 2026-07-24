import * as bridge from "../bridge";

/**
 * The desktop feature boundary. It deliberately mirrors the existing bridge
 * so the Rust command contract and preview behavior stay unchanged.
 */
export type DesktopClient = typeof bridge;

export const desktopClient: DesktopClient = bridge;

export const isDesktopRuntime = "__TAURI_INTERNALS__" in window;
