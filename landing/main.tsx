import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import HeroSection from "@/components/ui/glassmorphism-trust-hero";
import EvidenceSections from "@/components/ui/evidence-sections";
import BenchmarkPage from "@/components/ui/benchmark-page";
import "./styles.css";

// https://react.dev/reference/react-dom/client/createRoot#rendering-an-app-fully-built-with-react
const path = window.location.pathname.replace(/\/+$/, "");
const benchmark = path === "/benchmarks/answers" ? "answers" : path === "/benchmarks/draco" ? "draco" : null;
createRoot(document.getElementById("root")!).render(<StrictMode><main>{benchmark ? <BenchmarkPage kind={benchmark} /> : <><HeroSection /><EvidenceSections /></>}</main></StrictMode>);
