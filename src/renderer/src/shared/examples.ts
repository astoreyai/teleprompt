export type Example = {
  fileName: string
  label: string
  description: string
  content: string
}

const intro = `# Welcome

[[CUE: intro]]

This is a sample script with cue markers. Press Ctrl plus Alt plus 1 through 9 to jump between cues. Use the play button or the spacebar shortcut to start scrolling.

[[CUE: features]]

## What this script demonstrates

- Headings render with larger type when markdown rendering is on.
- Bullet points keep their indentation.
- Cue markers like the ones in this file are stripped from the visible text but appear as jump targets in the cue panel and the on-overlay HUD.
- The pacing target lets you set a duration or words per minute. The scroll speed adjusts to match.

[[CUE: closing]]

## Closing

That covers the basics. Replace this text with your own script, or load any of the other example formats from the same examples list to see how each one renders.`

const screenplay = `Title: A Quiet Morning
Author: Sample

INT. SMALL APARTMENT KITCHEN - MORNING

Light from a window. Coffee gear on the counter. SAM, mid thirties, fills a kettle from the tap.

SAM
Did the alarm go off twice or am I imagining things.

JORDAN, just awake, leans in the doorway.

JORDAN
Twice. The second one is the one that matters.

SAM
That seems backwards.

JORDAN
That is how it has always been.

Sam sets the kettle on the burner and lights the flame. Jordan moves to the table and sits.

SAM
Toast or oats today.

JORDAN
Oats. Slow morning.

The kettle begins to hum.`

const subtitle = `1
00:00:01,000 --> 00:00:04,000
This is the first line of a sample subtitle file.

2
00:00:05,000 --> 00:00:09,000
Each block has a number, a time range, and one or more lines of text.

3
00:00:10,000 --> 00:00:14,000
The teleprompter strips the numbers and timestamps and shows only the text.

4
00:00:15,000 --> 00:00:19,000
Multi line cues are joined with a single space when shown.`

const longText = `This is a sample plain text script. The point of this file is to give you a long enough document to test scrolling, pacing, and timing without needing to load anything external.

Section one. Setup.

Open the controls window. Set a duration target, for example five minutes. The scroll speed adjusts so that the scroll finishes in five minutes regardless of font size. If you change the font size, the duration stays the same. The chronometer in the corner of the overlay shows elapsed time, time to end, and the target words per minute.

Section two. Reading aids.

The eye line marker is the horizontal line that helps you keep your gaze near the camera. Move it up or down with the slider. Focus mode dims the lines outside the band around the eye line. Drop shadow improves contrast over busy backgrounds.

Section three. Live edit.

Toggle the live edit pane to revise the script while the overlay shows it. Edits are debounced and pushed to the overlay. Click save to write changes to the source file. For an unsaved memory file the save flow opens a dialog.

Section four. Voice pacing.

Voice pacing listens through the microphone and advances the script as you read. The first time you enable it a confirmation dialog explains that audio is processed by a cloud service. The status pill on the controls window reads voice cloud while pacing is active.

Section five. Cue points.

Insert cue markers in the script using the double bracket syntax. The cue panel lists every marker. The first nine markers are bound to keyboard shortcuts. The optional cue heads up display in the overlay corner shows the current and upcoming markers as you scroll past them.

Section six. Closing.

Replace this content with your own script. Drop in a markdown file, a docx, an odt, a fountain screenplay, an srt or vtt subtitle file, or a pdf with a real text layer. Each format is parsed to plain readable text inside the overlay.`

export const EXAMPLES: Example[] = [
  {
    fileName: 'sample-with-cues.md',
    label: 'Markdown with cues',
    description: 'Headings, bullets, and cue jump targets',
    content: intro,
  },
  {
    fileName: 'sample-screenplay.fountain',
    label: 'Fountain screenplay',
    description: 'Industry screenwriting plain-text format',
    content: screenplay,
  },
  {
    fileName: 'sample-subtitles.srt',
    label: 'SRT subtitles',
    description: 'Timestamps stripped automatically',
    content: subtitle,
  },
  {
    fileName: 'sample-long-script.txt',
    label: 'Long plain-text script',
    description: 'Multi-section script for scroll/pacing tests',
    content: longText,
  },
]
