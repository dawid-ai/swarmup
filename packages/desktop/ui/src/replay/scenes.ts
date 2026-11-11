// The scenes the Replay view offers, in picker order. A new visualisation is one module in
// `scenes/` that exports a `Scene`, plus one line here.
import type { Scene } from './scene';
import { constellationScene } from './scenes/constellation';
import { countersScene } from './scenes/counters';
import { eventsScene } from './scenes/events';
import { loopScene } from './scenes/loop';
import { metroScene } from './scenes/metro';
import { rallyScene } from './scenes/rally';
import { swimlanesScene } from './scenes/swimlanes';
import { wrappedScene } from './scenes/wrapped';

// `Scene` declares its functions as methods, so a `Scene<EventsData>` fits `Scene<unknown>`; the
// player only ever passes a scene's own `prepare` result back to its `render`.
export const SCENES: Array<Scene<unknown>> = [
  swimlanesScene,
  loopScene,
  eventsScene,
  countersScene,
  metroScene,
  constellationScene,
  wrappedScene,
  rallyScene,
];

export function sceneById(id: string): Scene<unknown> {
  return SCENES.find((s) => s.id === id) ?? SCENES[0]!;
}
