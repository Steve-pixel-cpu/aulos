import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

/** 首尾黑场过渡：inF 前淡入、outF 后淡出（duration 为过渡帧数） */
export const Fade: React.FC<{
  children: React.ReactNode;
  inF?: number;
  outF?: number;
  duration?: number;
}> = ({ children, inF = 0, outF = 0, duration = 15 }) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [inF, inF + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(frame, [outF - duration, outF], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOut) }}>
    {children}
  </AbsoluteFill>;
};
