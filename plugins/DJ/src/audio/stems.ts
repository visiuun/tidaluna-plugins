// TIDAL's side of the vocal separator (the work is done in a hidden page of its own: see stems.native.ts)
import core from "file://./stems.js";
import runner from "file://./stems.page.js";
import { stemsClose, stemsProgress, stemsReady, stemsSeparate } from "./stems.native";

const page = `${core}\n${runner}`;

/**
 * The separator works on pictures of 254976 samples and can't be trusted on the first and last 3072 of
 * what it is given. A piece is what is left of one picture's worth of sound once that much has been
 * given away at either end: 5.6 seconds, done in about half that.
 */
export const STEM_MARGIN = 3072;
export const STEM_PIECE = 254976 - 2 * STEM_MARGIN;

/** Gets the separator ready (the first time this downloads about 40 MB) */
export const prepareSeparator = () => stemsReady(page);
/** Takes the voice out of the sound the mixer left under `job`; the mixer picks the voice up from there */
export const separate = (job: string) => stemsSeparate(page, job);
export const separatorProgress = () => stemsProgress();
export const closeSeparator = () => stemsClose().catch(() => {});
