# Prompt Log

This is a concise record of the AI assistance used on the project, not a full
chat transcript. It intentionally contains no API keys, access tokens, personal
data, lyrics, or other secrets.

## Models and tools

- **Model:** OpenAI Codex using a GPT-5-family coding model.
- **Development tools:** PowerShell, the .NET CLI, NuGet, npm, Vite, TypeScript,
  Vitest, Three.js, Git, and the GitHub web interface.
- **Verification tools:** solution and frontend builds, xUnit and Vitest test
  suites, repository/ignore inspection, and a pre-publication credential scan.

## Key prompts that shaped the implementation

The following are short summaries of the most important implementation prompts
and constraints:

1. Build a Windows 11 desktop experience that turns Spotify process audio into
   a continuously evolving abstract environment, never a conventional waveform,
   spectrum, equalizer, or analytics dashboard.
2. Keep three independent execution lanes: real-time capture/DSP, background
   metadata and persistence, and rendering from normalized visual state.
3. Preserve the user's personal 12-note color mapping as the default; allow a
   separately selected mood-palette mode, while AI returns only bounded
   mood/texture categories and never colors or renderer code.
4. Treat Spotify, Last.fm, lyrics, and OpenAI as optional enrichment so local
   audio visualization continues through network, account, or provider failures;
   keep every secret in protected backend-only storage.
5. For each meaningful change, build every affected project, run focused and
   relevant full tests, perform any necessary real-world audio/visual check, and
   clearly report anything that remains unverified.
6. Publish the complete source project in a new GitHub repository with a README
   that explains API calls, credential setup, installation, running, and this
   prompt log without exposing any key.
