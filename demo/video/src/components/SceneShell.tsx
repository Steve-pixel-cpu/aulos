import React from "react";
import { AbsoluteFill } from "remotion";
import { COLORS } from "../styles";

/** 场景容器：暗底 + 裁切层（2K 素材铺满 1080p comp 由 Zoomable 内层处理） */
export const SceneShell: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <AbsoluteFill style={{ background: COLORS.bg }}>
    <AbsoluteFill style={{ overflow: "hidden" }}>{children}</AbsoluteFill>
  </AbsoluteFill>
);
