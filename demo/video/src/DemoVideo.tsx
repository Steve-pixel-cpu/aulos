import React from "react";
import { Sequence } from "remotion";
import { Intro } from "./scenes/Intro";
import { Outro } from "./scenes/Outro";
import { DesktopScene } from "./scenes/DesktopScene";
import { McpScene } from "./scenes/McpScene";
import { INTRO, DESKTOP, MCP, OUTRO } from "./timing";

/** 完整时间线：片头 → 桌面端会话 → MCP 能力 → 片尾（只演示桌面端操作） */
export const DemoVideo: React.FC = () => (
  <>
    <Sequence from={0} durationInFrames={INTRO}>
      <Intro />
    </Sequence>
    <Sequence from={INTRO} durationInFrames={DESKTOP}>
      <DesktopScene />
    </Sequence>
    <Sequence from={INTRO + DESKTOP} durationInFrames={MCP}>
      <McpScene />
    </Sequence>
    <Sequence from={INTRO + DESKTOP + MCP} durationInFrames={OUTRO}>
      <Outro />
    </Sequence>
  </>
);
