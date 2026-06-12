/**
 * Data & sync domain — storage rotation decision logic
 * (`sync.storage-rotation`, issue #54). The storage side lives in
 * `@linky/evolu-store`; core only owns the pure, convergent rules.
 */
export * from "./storageRotation.js";
