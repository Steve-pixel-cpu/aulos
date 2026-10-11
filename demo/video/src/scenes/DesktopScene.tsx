import React from "react";
import { AbsoluteFill } from "remotion";
import { Zoomable } from "../components/Zoomable";
import { KineticSubtitle } from "../components/KineticSubtitle";
import { ChapterBar } from "../components/ChapterBar";
import { SafeVideo } from "../components/SafeVideo";
import { SceneShell } from "../components/SceneShell";

/** 干活② 桌面端会话：计划卡/工具活动流，两处 zoom */
export const DesktopScene: React.FC = () => (
  <SceneShell>
    <Zoomable
      keys={[
        { frame: 0, scale: 1.0, x: 960, y: 540 },
        { frame: 50, scale: 1.5, x: 1250, y: 500 },
        { frame: 220, scale: 1.5, x: 1250, y: 500 },
        { frame: 280, scale: 1.0, x: 960, y: 540 },
        { frame: 600, scale: 1.6, x: 800, y: 640 },
        { frame: 660, scale: 1.0, x: 960, y: 540 },
      ]}
    >
      <AbsoluteFill>
        <SafeVideo src="raw/desktop_2k.mp4" speed={5} startFrom={0} />
      </AbsoluteFill>
    </Zoomable>
    <ChapterBar index="02" title="桌面端 · 会话与计划卡" delay={40} />
    <KineticSubtitle lines={["看着它思考 每一步"]} startFrame={110} />
  </SceneShell>
);
