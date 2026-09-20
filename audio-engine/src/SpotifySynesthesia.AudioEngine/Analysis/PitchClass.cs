using System.Text.Json.Serialization;

namespace SpotifySynesthesia.AudioEngine.Analysis;

[JsonConverter(typeof(JsonStringEnumConverter<PitchClass>))]
public enum PitchClass
{
    C,
    CSharp,
    D,
    DSharp,
    E,
    F,
    FSharp,
    G,
    GSharp,
    A,
    ASharp,
    B,
}
