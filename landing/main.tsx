import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import HeroSection from "@/components/ui/glassmorphism-trust-hero";
import EvidenceSections from "@/components/ui/evidence-sections";
import "./styles.css";

// https://react.dev/reference/react-dom/client/createRoot#rendering-an-app-fully-built-with-react
createRoot(document.getElementById("root")!).render(<StrictMode><main><HeroSection /><EvidenceSections /></main></StrictMode>);
