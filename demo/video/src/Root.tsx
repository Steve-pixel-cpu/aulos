import React from "react";
import { Composition } from "remotion";
import { DemoVideo } from "./DemoVideo";
import { TOTAL } from "./timing";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="DemoVideo"
    component={DemoVideo}
    durationInFrames={TOTAL}
    fps={30}
    width={1920}
    height={1080}
  />
);
