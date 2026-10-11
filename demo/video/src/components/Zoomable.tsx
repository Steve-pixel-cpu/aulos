import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  Easing,
} from "remotion";

export type ZoomKey = { frame: number; scale: number; x: number; y: number };

/** 关键帧缩放平移容器：坐标为 1080p comp 像素（x,y 为推近的屏幕中心点） */
export const Zoomable: React.FC<{
  keys: ZoomKey[];
  children: React.ReactNode;
}> = ({ keys, children }) => {
  const frame = useCurrentFrame();
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  const mk = (pick: (k: ZoomKey) => number) =>
    interpolate(
      frame,
      sorted.map((k) => k.frame),
      sorted.map(pick),
      {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.inOut(Easing.cubic),
      },
    );
  const scale = mk((k) => k.scale);
  const x = mk((k) => k.x);
  const y = mk((k) => k.y);
  return (
    <AbsoluteFill
      style={{ transform: `scale(${scale}) translate(${-x}px, ${-y}px)` }}
    >
      {children}
    </AbsoluteFill>
  );
};
