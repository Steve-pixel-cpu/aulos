import React from "react";
import { Composition } from "remotion";
import { DemoVideo } from "./DemoVideo";
import { StyleSample } from "./StyleSample";
import { TOTAL } from "./timing";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="DemoVideo"
      component={DemoVideo}
      durationInFrames={TOTAL}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="StyleSample"
      component={StyleSample}
      durationInFrames={450}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);

