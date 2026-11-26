/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        obsidian: "#0b0d13",
        panel: "#131722",
        panelHover: "#1a2030",
        edge: "#273046"
      }
    }
  },
  plugins: []
};
