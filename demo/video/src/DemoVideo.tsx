import React from "react";
import { Sequence } from "remotion";
import { Intro } from "./scenes/Intro";
import { Outro } from "./scenes/Outro";
import { CliScene } from "./scenes/CliScene";
import { DesktopScene } from "./scenes/DesktopScene";
import { McpScene } from "./scenes/McpScene";
import { INTRO, CLI, DESKTOP, MCP, OUTRO } from "./timing";

/** 完整时间线：片头 → 干活① → 干活② → MCP → 片尾 */
export const DemoVideo: React.FC = () => (
  <>
    <Sequence from={0} durationInFrames={INTRO}>
      <Intro />
    </Sequence>
    <Sequence from={INTRO} durationInFrames={CLI}>
      <CliScene />
    </Sequence>
    <Sequence from={INTRO + CLI} durationInFrames={DESKTOP}>
      <DesktopScene />
    </Sequence>
    <Sequence from={INTRO + CLI + DESKTOP} durationInFrames={MCP}>
      <McpScene />
    </Sequence>
    <Sequence from={INTRO + CLI + DESKTOP + MCP} durationInFrames={OUTRO}>
      <Outro />
    </Sequence>
  </>
);
