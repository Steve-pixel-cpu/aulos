import React from "react";
import { Sequence } from "remotion";
import { Intro } from "./scenes/Intro";
import { Outro } from "./scenes/Outro";
import { DesktopScene } from "./scenes/DesktopScene";

/** 15s 风格样片：片头 5s + 桌面端场景开头 7s + 片尾 3s */
export const StyleSample: React.FC = () => (
  <>
    <Sequence from={0} durationInFrames={150}>
      <Intro />
    </Sequence>
    <Sequence from={150} durationInFrames={210}>
      <DesktopScene />
    </Sequence>
    <Sequence from={360} durationInFrames={90}>
      <Outro />
    </Sequence>
  </>
);
