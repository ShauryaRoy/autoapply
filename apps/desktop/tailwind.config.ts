import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./src/renderer/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          bg: "#0B0F14",
          card: "#111827"
        }
      },
      borderRadius: {
        xl: "12px",
        "2xl": "16px"
      }
    }
  },
  plugins: []
} satisfies Config;
