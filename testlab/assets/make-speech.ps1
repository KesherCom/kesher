# Generates testlab/assets/speech.wav, the speech reference for the desktop
# audio benchmark (PESQ scoring). Uses the offline Windows speech voices, so
# the clip has no licensing strings attached and can be regenerated.
#
#   powershell -ExecutionPolicy Bypass -File testlab/assets/make-speech.ps1
#
# Format: 48 kHz, 16-bit, mono. Sentences alternate German/English with short
# pauses, so the engine sees talk spurts like in real intercom use.

Add-Type -AssemblyName System.Speech

$out = Join-Path $PSScriptRoot "speech.wav"
$lines = @(
  @{ Voice = "de-DE"; Text = "Kamera zwei, bitte langsam auf die Bühne schwenken." },
  @{ Voice = "en-US"; Text = "Lighting, stand by for cue twenty-four." },
  @{ Voice = "de-DE"; Text = "Ton, das Mikrofon vom Sprecher ist noch stumm." },
  @{ Voice = "en-US"; Text = "Stage left, the band is ready in thirty seconds." },
  @{ Voice = "de-DE"; Text = "Regie an alle: Wir gehen in zehn Sekunden live." },
  @{ Voice = "en-US"; Text = "Copy that, playback rolling on my mark." }
)

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($out, $format)
$synth.Rate = 0
$prompt = New-Object System.Speech.Synthesis.PromptBuilder
foreach ($line in $lines) {
  $voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq $line.Voice } | Select-Object -First 1
  if (-not $voice) { throw "No installed voice for $($line.Voice)" }
  $prompt.StartVoice($voice.VoiceInfo)
  $prompt.AppendText($line.Text)
  $prompt.EndVoice()
  $prompt.AppendBreak([TimeSpan]::FromMilliseconds(700))
}
$synth.Speak($prompt)
$synth.Dispose()
Write-Output "wrote $out"
