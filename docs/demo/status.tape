# Shared settings: keep the Output and Set lines below the same in every tape
# (install, setup, issue, status), except the Output names. Each tape repeats
# them because VHS has no include for settings.
Output docs/demo/out/status.gif
Output docs/demo/out/status.mp4

Require autopilot

Set Shell "bash"
Set FontSize 22
Set Width 1280
Set Height 720
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

Hide
Type "export PS1='$ ' && clear"
Enter
Show

Type "autopilot hosts"
Sleep 500ms
Enter
Sleep 3s

Type "autopilot watch"
Sleep 500ms
Enter
Sleep 3s

Type "autopilot status"
Sleep 500ms
Enter
Sleep 8s
