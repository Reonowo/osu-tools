// port of osu.framework's defaulteasingfunction.cs (tag 2026.731.0). each
// function maps normalized time [0,1] -> progress; formulas are verbatim,
// including the offset constants that pin expo/elastic to exact 0/1 endpoints

export type EasingFn = (t: number) => number;

const ELASTIC_CONST = (2 * Math.PI) / 0.3;
const ELASTIC_CONST2 = 0.3 / 4;
const BACK_CONST = 1.70158;
const BACK_CONST2 = BACK_CONST * 1.525;
const BOUNCE_CONST = 1 / 2.75;
const EXPO_OFFSET = Math.pow(2, -10);
const ELASTIC_OFFSET_FULL = Math.pow(2, -11);
const ELASTIC_OFFSET_HALF = Math.pow(2, -10) * Math.sin((0.5 - ELASTIC_CONST2) * ELASTIC_CONST);
const ELASTIC_OFFSET_QUARTER = Math.pow(2, -10) * Math.sin((0.25 - ELASTIC_CONST2) * ELASTIC_CONST);
const IN_OUT_ELASTIC_OFFSET = Math.pow(2, -10) * Math.sin(((1 - ELASTIC_CONST2 * 1.5) * ELASTIC_CONST) / 1.5);

export const none: EasingFn = (t) => t;
export const inQuad: EasingFn = (t) => t * t;
export const outQuad: EasingFn = (t) => t * (2 - t);
export const inOutQuad: EasingFn = (t) => {
  if (t < 0.5) return t * t * 2;
  const u = t - 1;
  return u * u * -2 + 1;
};
export const inCubic: EasingFn = (t) => t * t * t;
export const outCubic: EasingFn = (t) => {
  const u = t - 1;
  return u * u * u + 1;
};
export const inOutCubic: EasingFn = (t) => {
  if (t < 0.5) return t * t * t * 4;
  const u = t - 1;
  return u * u * u * 4 + 1;
};
export const inQuart: EasingFn = (t) => t * t * t * t;
export const outQuart: EasingFn = (t) => {
  const u = t - 1;
  return 1 - u * u * u * u;
};
export const inOutQuart: EasingFn = (t) => {
  if (t < 0.5) return t * t * t * t * 8;
  const u = t - 1;
  return u * u * u * u * -8 + 1;
};
export const inQuint: EasingFn = (t) => t * t * t * t * t;
export const outQuint: EasingFn = (t) => {
  const u = t - 1;
  return u * u * u * u * u + 1;
};
export const inOutQuint: EasingFn = (t) => {
  if (t < 0.5) return t * t * t * t * t * 16;
  const u = t - 1;
  return u * u * u * u * u * 16 + 1;
};
export const inSine: EasingFn = (t) => 1 - Math.cos(t * Math.PI * 0.5);
export const outSine: EasingFn = (t) => Math.sin(t * Math.PI * 0.5);
export const inOutSine: EasingFn = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
export const inExpo: EasingFn = (t) => Math.pow(2, 10 * (t - 1)) + EXPO_OFFSET * (t - 1);
export const outExpo: EasingFn = (t) => -Math.pow(2, -10 * t) + 1 + EXPO_OFFSET * t;
export const inOutExpo: EasingFn = (t) => {
  if (t < 0.5) return 0.5 * (Math.pow(2, 20 * t - 10) + EXPO_OFFSET * (2 * t - 1));
  return 1 - 0.5 * (Math.pow(2, -20 * t + 10) + EXPO_OFFSET * (-2 * t + 1));
};
export const inCirc: EasingFn = (t) => 1 - Math.sqrt(1 - t * t);
export const outCirc: EasingFn = (t) => {
  const u = t - 1;
  return Math.sqrt(1 - u * u);
};
export const inOutCirc: EasingFn = (t) => {
  let u = t * 2;
  if (u < 1) return 0.5 - 0.5 * Math.sqrt(1 - u * u);
  u -= 2;
  return 0.5 * Math.sqrt(1 - u * u) + 0.5;
};
export const inElastic: EasingFn = (t) =>
  -Math.pow(2, -10 + 10 * t) * Math.sin((1 - ELASTIC_CONST2 - t) * ELASTIC_CONST) +
  ELASTIC_OFFSET_FULL * (1 - t);
export const outElastic: EasingFn = (t) =>
  Math.pow(2, -10 * t) * Math.sin((t - ELASTIC_CONST2) * ELASTIC_CONST) + 1 -
  ELASTIC_OFFSET_FULL * t;
export const outElasticHalf: EasingFn = (t) =>
  Math.pow(2, -10 * t) * Math.sin((0.5 * t - ELASTIC_CONST2) * ELASTIC_CONST) + 1 -
  ELASTIC_OFFSET_HALF * t;
export const outElasticQuarter: EasingFn = (t) =>
  Math.pow(2, -10 * t) * Math.sin((0.25 * t - ELASTIC_CONST2) * ELASTIC_CONST) + 1 -
  ELASTIC_OFFSET_QUARTER * t;
export const inOutElastic: EasingFn = (t) => {
  let u = t * 2;
  if (u < 1) {
    return -0.5 * (
      Math.pow(2, -10 + 10 * u) * Math.sin(((1 - ELASTIC_CONST2 * 1.5 - u) * ELASTIC_CONST) / 1.5) -
      IN_OUT_ELASTIC_OFFSET * (1 - u)
    );
  }
  u -= 1;
  return 0.5 * (
    Math.pow(2, -10 * u) * Math.sin(((u - ELASTIC_CONST2 * 1.5) * ELASTIC_CONST) / 1.5) -
    IN_OUT_ELASTIC_OFFSET * u
  ) + 1;
};
export const inBack: EasingFn = (t) => t * t * ((BACK_CONST + 1) * t - BACK_CONST);
export const outBack: EasingFn = (t) => {
  const u = t - 1;
  return u * u * ((BACK_CONST + 1) * u + BACK_CONST) + 1;
};
export const inOutBack: EasingFn = (t) => {
  let u = t * 2;
  if (u < 1) return 0.5 * u * u * ((BACK_CONST2 + 1) * u - BACK_CONST2);
  u -= 2;
  return 0.5 * (u * u * ((BACK_CONST2 + 1) * u + BACK_CONST2) + 2);
};
export const outBounce: EasingFn = (t) => {
  if (t < BOUNCE_CONST) return 7.5625 * t * t;
  if (t < 2 * BOUNCE_CONST) {
    const u = t - 1.5 * BOUNCE_CONST;
    return 7.5625 * u * u + 0.75;
  }
  if (t < 2.5 * BOUNCE_CONST) {
    const u = t - 2.25 * BOUNCE_CONST;
    return 7.5625 * u * u + 0.9375;
  }
  const u = t - 2.625 * BOUNCE_CONST;
  return 7.5625 * u * u + 0.984375;
};
export const inBounce: EasingFn = (t) => 1 - outBounce(1 - t);
export const inOutBounce: EasingFn = (t) => {
  if (t < 0.5) return 0.5 - 0.5 * outBounce(1 - t * 2);
  return outBounce((t - 0.5) * 2) * 0.5 + 0.5;
};
export const outPow10: EasingFn = (t) => {
  const u = t - 1;
  return u * Math.pow(u, 10) + 1;
};

// c#'s In/Out are aliases of InQuad/OutQuad (defaulteasingfunction.cs:46-52)
export const easeIn = inQuad;
export const out = outQuad;

export const EASINGS: Record<string, EasingFn> = {
  None: none,
  Out: out,
  In: easeIn,
  InQuad: inQuad, OutQuad: outQuad, InOutQuad: inOutQuad,
  InCubic: inCubic, OutCubic: outCubic, InOutCubic: inOutCubic,
  InQuart: inQuart, OutQuart: outQuart, InOutQuart: inOutQuart,
  InQuint: inQuint, OutQuint: outQuint, InOutQuint: inOutQuint,
  InSine: inSine, OutSine: outSine, InOutSine: inOutSine,
  InExpo: inExpo, OutExpo: outExpo, InOutExpo: inOutExpo,
  InCirc: inCirc, OutCirc: outCirc, InOutCirc: inOutCirc,
  InElastic: inElastic, OutElastic: outElastic,
  OutElasticHalf: outElasticHalf, OutElasticQuarter: outElasticQuarter,
  InOutElastic: inOutElastic,
  InBack: inBack, OutBack: outBack, InOutBack: inOutBack,
  InBounce: inBounce, OutBounce: outBounce, InOutBounce: inOutBounce,
  OutPow10: outPow10,
};
