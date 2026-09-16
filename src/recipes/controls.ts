import { STAGES, type ParamSpec, type StageType } from "./model";

/** The photographer's main adjustment. Other values describe the recipe's character. */
const MAIN: Record<StageType, string> = {
  resolutionSoften: "amount",
  sharpen: "amount",
  chromaticAberration: "shift",
  temperatureTint: "temperature",
  saturation: "amount",
  contrast: "amount",
  levels: "gamma",
  halation: "strength",
  vignette: "strength",
  grain: "opacity",
  border: "width",
};

export function stageControls(stage: StageType): { main: ParamSpec; fine: readonly ParamSpec[] } {
  const spec = STAGES.find((item) => item.type === stage)!;
  const main = spec.params.find((param) => param.param === MAIN[stage])!;
  return {
    main: { ...main, label: stage === "levels" ? "Midtones" : spec.label },
    fine: spec.params.filter((param) => param.param !== main.param),
  };
}
