# Public document inputs

These are unmodified official publications, not documents generated for testing. Their URLs, retrieval timestamps, byte lengths, SHA-256 digests, and attribution are recorded in `provenance.json`.

- `dwi-privacy-notice.docx`: the Drinking Water Inspectorate’s actual published privacy notice. The official source page identifies its content as Open Government Licence v3.0 except where otherwise stated. Contains public sector information licensed under the Open Government Licence v3.0. Source: Drinking Water Inspectorate. The DOCX contains no embedded media and no separate copyright exception in its document text.
- `us-constitution.pdf`: the constitutional text published in the United States Government Manual by the Office of the Federal Register, National Archives and Records Administration, distributed by the Government Publishing Office. This United States government work is in the public domain. The document is text-only; the GovInfo public-domain policy is linked in the provenance record.

Both documents exercise real structured-document extraction and archive/output limits. They do not qualify malformed archives, malicious compressed documents, or every supported format. Operator documents and native crash dumps remain private and are not included here.

The paired `nasa-atom-alaska.srt` and `.vtt` captions are unchanged files from [ATom Postcard — Alaska and the Arctic](https://svs.gsfc.nasa.gov/12508/), credited to NASA's Goddard Space Flight Center. Acquisition details and hashes are in `nasa-atom-alaska.provenance.json`. Only the factual captions are included, not the video's third-party music. NASA's [media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) permit factual informational use with source acknowledgement; no endorsement is implied.

The captions intentionally retain the publication's trailing spaces, carriage return, and final blank lines. Do not format them: their exact bytes are covered by provenance hashes.

`legacy-0.1.0` and `legacy-1.0.3` contain unmodified state emitted by the actual released applications using repository documents in isolated profiles. Their local provenance records identify the source release, executable archive, input hashes, and capture actions. They contain temporary public-document paths and no operator profile data.

`localization` contains two exact production translations selected from the installed newt message catalogs. Its provenance, upstream source reference, and license are included beside the selected text.
