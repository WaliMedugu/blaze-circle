import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Blaze-Grid",
    short_name: "Blaze",
    description: "Pay and get paid on campus, even with zero data.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#071426",
    theme_color: "#071426",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
