/** @type {import('tailwindcss').Config} */
module.exports = {
  // NB: paths must cover every workspace package that uses className,
  // including @linky/ui sources (symlinked via pnpm, so use the real path).
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  presets: [require("@linky/ui/tailwind-preset")],
};
