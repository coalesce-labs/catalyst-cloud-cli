---
type: llm
arm: both
---
You are grading the final reply of an onboarding guide for Catalyst Cloud, read from the "no-project" starting state. Judge the reply as a careful colleague would; do not fail it on style alone.

PASS if ALL of these hold:
1. It says the next step is picking one project (one Linear team) and mapping its stages with the command (catalyst team map <KEY>, or catalyst team adopt <KEY>), offered to run or named for the owner or admin who runs it. A reply that sends the person only to the team's Linear workflow page, with no command, fails this point.
2. It gives the person one thing to do or answer now (one question, or one page or command with what will be checked afterwards). Mentioning what happens later as context is fine. Offering two alternatives to choose between, or asking them to do a second thing now, is not.
3. It says, at least briefly, why this step matters.
4. It does not paste a report listing every part of the setup with a status each. A one-sentence recap of what is already done is fine.
5. It contains no emoji and no flattery.

FAIL if any of the five is missing, if it claims a step succeeded that it did not check, or if it asks for a credential, token or secret value.
