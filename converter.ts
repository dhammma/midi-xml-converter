import { XMLParser } from "fast-xml-parser";
import fs from "fs";
import { z } from "zod";
import { PianoKey } from "./PianoKey";
import { PIANO_KEY_BY_MIDI_NUMBER } from "./midiNumberToPianoKey";

const xmlTextContent = fs.readFileSync("./49664.xml");
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
});
const xmlObject = parser.parse(xmlTextContent);
const jsObject = z
  .object({
    MIDIFile: z.object({
      TicksPerBeat: z.number(),
      Track: z.array(
        z.object({
          Event: z.array(
            z.object({
              Delta: z.number(),
              NoteOn: z
                .object({
                  "@Note": z.string(),
                })
                .optional(),
              NoteOff: z
                .object({
                  "@Note": z.string(),
                })
                .optional(),
            })
          ),
        })
      ),
    }),
  })
  .parse(xmlObject);

interface PianoNote {
  startInWholes: number;
  startInTicks: number;
  pianoKey: PianoKey;
  durationInTicks?: number;
  durationInWholes?: number;
}

const DURATION_BY_WHOLE = new Map<number, string>([
  [1.5, "1."],
  [1, "1"],
  [(1 / 2) * 1.5, "2."],
  [1 / 2, "2"],
  [(1 / 4) * 1.5, "4."],
  [1 / 4, "4"],
  [(1 / 8) * 1.5, "8."],
  [1 / 8, "8"],
  [(1 / 16) * 1.5, "16."],
  [1 / 16, "16"],
  [(1 / 32) * 1.5, "32."],
  [1 / 32, "32"],
]);
const DURATIONS = [...DURATION_BY_WHOLE.keys()];

const breakdownNoteByDuration = (note: PianoNote) => {
  const result: PianoNote[] = [];
  let remaingingNoteDuration = note.durationInWholes!;

  let durationIndex = 0;
  let offsetInWholes = 0;
  while (remaingingNoteDuration > 0) {
    if (DURATIONS[durationIndex] >= note.durationInWholes!) {
      result.push({
        ...note,
        startInWholes: note.startInWholes + offsetInWholes,
        durationInWholes: DURATIONS[durationIndex],
      });
      offsetInWholes += DURATIONS[durationIndex];
      remaingingNoteDuration -= DURATIONS[durationIndex];
    } else {
      durationIndex--;
    }
  }

  return result;
};

const tracks = jsObject.MIDIFile.Track.map((itemTrack) => {
  const trackOpenedNotes = new Map<PianoKey, PianoNote>();
  const trackNotes: PianoNote[] = [];
  let currentPos = 0;

  itemTrack.Event.forEach((itemEvent) => {
    currentPos += itemEvent.Delta;
    if (itemEvent.NoteOn) {
      const midiNumber = Number(itemEvent.NoteOn["@Note"]);
      const pianoKey = PIANO_KEY_BY_MIDI_NUMBER[midiNumber];

      if (!pianoKey) {
        throw new Error(
          `Out of range midi number: ${JSON.stringify(itemEvent)}`
        );
      }

      if (trackOpenedNotes.get(pianoKey)) {
        // TODO: ignore case
        return;
        throw new Error(
          `Can't be opened two notes simultaneously: ${JSON.stringify(
            itemEvent
          )}, ${JSON.stringify(trackOpenedNotes.get(pianoKey))}`
        );
      }

      const note: PianoNote = {
        startInTicks: currentPos,
        startInWholes: currentPos / jsObject.MIDIFile.TicksPerBeat / 4,
        pianoKey: PIANO_KEY_BY_MIDI_NUMBER[midiNumber],
      };
      trackOpenedNotes.set(pianoKey, note);
      trackNotes.push(note);
    }

    if (itemEvent.NoteOff) {
      const midiNumber = Number(itemEvent.NoteOff["@Note"]);
      const pianoKey = PIANO_KEY_BY_MIDI_NUMBER[midiNumber];

      if (!pianoKey) {
        throw new Error(
          `Out of range midi number: ${JSON.stringify(itemEvent)}`
        );
      }

      const startNote = trackOpenedNotes.get(pianoKey);
      if (!startNote) {
        // TODO: ignore case
        return;
        throw new Error(
          `Can't find opened note for closing note: ${JSON.stringify(
            itemEvent
          )}`
        );
      }

      startNote.durationInTicks = currentPos - startNote.startInTicks;
      startNote.durationInWholes =
        startNote.durationInTicks! / Number(jsObject.MIDIFile.TicksPerBeat) / 4;
      trackOpenedNotes.delete(pianoKey);
    }
  }, new Array<PianoNote>());

  return trackNotes;
});

// split to voices

const trackVoices = tracks.map((itemTrack) => {
  const voices: PianoNote[][] = [[], [], [], [], [], [], [], []];
  itemTrack.forEach((itemNote) => {
    const voice = voices.find((itemVoice) => {
      return (
        itemVoice.filter((itemNoteInVoice) => {
          const itemNoteInVoiceEndTime =
            itemNoteInVoice.startInTicks + itemNoteInVoice.durationInTicks!;
          if (
            itemNote.startInTicks >= itemNoteInVoice.startInTicks &&
            itemNote.startInTicks <=
              itemNoteInVoice.startInTicks + itemNoteInVoice.durationInTicks!
          ) {
            return true;
          }
          const itemNoteEndTime =
            itemNote.startInTicks + itemNote.durationInTicks!;

          if (
            itemNoteEndTime >= itemNoteInVoice.startInTicks &&
            itemNoteEndTime <= itemNoteInVoiceEndTime
          ) {
            return true;
          }

          return false;
        }).length === 0
      );
    });

    if (!voice) {
      throw new Error(`Can't find the voice for note`);
    }

    const notesBreakDown = breakdownNoteByDuration(itemNote);

    voice.push(...notesBreakDown);
  });
  return voices;
});

trackVoices.forEach((itemVoice, indexTrack) => {
  console.log(`---track ${indexTrack + 1}`);

  itemVoice
    .filter((itemVoice) => itemVoice.length > 0)
    .forEach((itemVoice, voiceIndex) => {
      console.log(`-----voice ${voiceIndex + 1}`);
      console.log(
        itemVoice
          .map((itemNote, index) => {
            let pauseText = "";
            const prevNote = itemVoice[index - 1];
            const deltaInWholes =
              prevNote &&
              itemNote.startInWholes -
                prevNote.startInWholes -
                prevNote.durationInWholes!;

            if (deltaInWholes) {
              // insert pauses
              const pauseNokiaDuration = DURATION_BY_WHOLE.get(
                itemNote.durationInWholes!
              )!;
              pauseText = [
                pauseNokiaDuration.replace(".", ""),
                "p",
                pauseNokiaDuration.endsWith(".") ? "." : "",
                ",",
              ].join("");
            }
            const nokiaDuration = DURATION_BY_WHOLE.get(
              itemNote.durationInWholes!
            )!;
            const durationTextToken = nokiaDuration.replace(".", "");
            const pianoKeyTextToken = itemNote.pianoKey.toLowerCase();
            const pointTextToken = nokiaDuration.endsWith(".") ? "." : "";

            return [
              pauseText,
              durationTextToken,
              pianoKeyTextToken,
              pointTextToken,
            ].join("");
          })
          .join(",")
      );
    });
});
