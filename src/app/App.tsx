import { useEffect } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";
import { useAppStore } from "@/lib/store";
import { AppShell } from "@/components/layout/AppShell";
import { ErrorBoundary, RouteFallback } from "@/components/ui/Feedback";
import { ToastProvider } from "@/components/ui/Controls";

const Home = lazy(() => import("@/routes/Home"));
const Tracks = lazy(() => import("@/routes/Tracks"));
const AllModules = lazy(() => import("@/routes/AllModules"));
const Track = lazy(() => import("@/routes/Track"));
const Module = lazy(() => import("@/routes/Module"));
const CaseFiles = lazy(() => import("@/routes/CaseFiles"));
const CaseFile = lazy(() => import("@/routes/CaseFile"));
const Review = lazy(() => import("@/routes/Review"));
const Glossary = lazy(() => import("@/routes/Glossary"));
const Progress = lazy(() => import("@/routes/Progress"));
const About = lazy(() => import("@/routes/About"));
const Lab = lazy(() => import("@/routes/Lab"));
const NotFound = lazy(() => import("@/routes/NotFound"));

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const target = document.getElementById(hash.slice(1));
      if (target) {
        target.scrollIntoView({ block: "start" });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

function ThemeEffect() {
  const theme = useAppStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute("content", theme === "dark" ? "#0A0E13" : "#F6F7F9");
  }, [theme]);
  return null;
}

export default function App() {
  const basename = import.meta.env.BASE_URL === "/" ? undefined : import.meta.env.BASE_URL.replace(/\/$/, "");
  return (
    <BrowserRouter basename={basename}>
      <ThemeEffect />
      <ScrollToTop />
      <ToastProvider>
        <AppShell>
          <ErrorBoundary>
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/tracks" element={<Tracks />} />
                <Route path="/curriculum" element={<AllModules />} />
                <Route path="/tracks/:trackId" element={<Track />} />
                <Route path="/modules/:slug" element={<Module />} />
                <Route path="/case-files" element={<CaseFiles />} />
                <Route path="/case-files/:slug" element={<CaseFile />} />
                <Route path="/review" element={<Review />} />
                <Route path="/glossary" element={<Glossary />} />
                <Route path="/progress" element={<Progress />} />
                <Route path="/about" element={<About />} />
                <Route path="/_lab" element={<Lab />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </AppShell>
      </ToastProvider>
    </BrowserRouter>
  );
}
