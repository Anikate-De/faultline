import { createContext, useContext, type RefObject } from "react";
import type { SimulationController } from "@/simulation/engine/useSimulation";

interface SimControllerContextValue {
  ref: RefObject<SimulationController | null>;
}

export const SimControllerContext = createContext<SimControllerContextValue | null>(null);

export function useSimController(): SimulationController | null {
  const context = useContext(SimControllerContext);
  return context?.ref.current ?? null;
}
