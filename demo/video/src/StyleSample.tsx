import React from "react";
import { Sequence } from "remotion";
import { Intro } from "./scenes/Intro";
import { Outro } from "./scenes/Outro";
import { CliScene } from "./scenes/CliScene";

/** 15s 风格样片：片头 4s + CliScene 开头 7s + 片尾 4s */
export const StyleSample: React.FC = () => (
  <>
    <Sequence from={0} durationInFrames={120}>
      <Intro />
    </Sequence>
    <Sequence from={120} durationInFrames={210}>
      <CliScene />
    </Sequence>
    <Sequence from={330} durationInFrames={120}>
      <Outro />
    </Sequence>
  </>
);
