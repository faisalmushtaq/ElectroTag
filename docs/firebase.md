# Running a study on Firebase

This guide sets up a real study of ElectroTag, step by step, for a study
administrator who is not a software developer. At the end, annotators open a link, sign in with an
email address and a password, open the recordings they were given on their own computer and
annotate them; the EEG never leaves their computer. Their results, training progress and
interaction logs are kept in your own Firebase project, in Google's London region, and one command
turns them into ElectroTag's usual folders for the agreement and activity analyses.

The pieces are Firebase Authentication (accounts), Firestore (the study's records),
ElectroTag's Cloud Functions (the private work: matching a file to the study, checking and saving
annotations, the training coach and practice scores, so the experts' answers never reach a
browser) and Firebase Hosting, which publishes the application from the same project at
`https://<project-id>.web.app`. Each Firebase project therefore serves its own copy of the
application, which finds its project by itself, so several research groups, or one group's
separate projects, can each run ElectroTag without sharing a website or a settings file. You run
ElectroTag's administrator command, `electrotag web`, on your own computer, where the recordings
are.

Allow an afternoon for the first set-up. Steps 1 to 8 are done once per Firebase project, and one
project can hold several studies; steps 9 to 14 are done once per study. Once you have signed in
with your own administrator account (step 11), the study is run from the **admin area** of the
application (docs/admin_area.md): adding recordings, accounts, assignments, reference sets,
settings, the analyses and the results. The commands below remain an alternative for each of these,
and "Coming back to a study later", after step 14, explains how to open a terminal for them again
on a later day.

Commands are typed in a terminal: Terminal on macOS and Linux, and PowerShell on Windows. Where a
command differs between the two, the guide gives both versions, one after the other; where only
one block is shown, it works as it stands in both.

<!-- contents: made by scripts/docs_contents.py from the headings; run it after changing them -->
**Contents**

- [What you need](#what-you-need)
- [1. Install the administrator's tools](#1-install-the-administrators-tools)
- [2. Create the Firebase project](#2-create-the-firebase-project)
- [3. Choose the pay-as-you-go plan and set a budget alert](#3-choose-the-pay-as-you-go-plan-and-set-a-budget-alert)
- [4. Create the Firestore database in London](#4-create-the-firestore-database-in-london)
- [5. Turn on sign-in with email and password](#5-turn-on-sign-in-with-email-and-password)
- [6. Register the web application and its website](#6-register-the-web-application-and-its-website)
- [7. A key for the administrator's command](#7-a-key-for-the-administrators-command)
- [8. Deploy the rules, the functions and the application](#8-deploy-the-rules-the-functions-and-the-application)
- [9. Create the study](#9-create-the-study)
- [10. Create your own administrator account](#10-create-your-own-administrator-account)
- [11. Sign in to the application](#11-sign-in-to-the-application)
- [12. Set the study up in the admin area](#12-set-the-study-up-in-the-admin-area)
- [13. Send the link and the recordings](#13-send-the-link-and-the-recordings)
- [14. Export the results for the analyses](#14-export-the-results-for-the-analyses)
- [Coming back to a study later](#coming-back-to-a-study-later)
- [Deploying updates from GitHub (optional)](#deploying-updates-from-github-optional)
- [Publishing the application elsewhere (optional)](#publishing-the-application-elsewhere-optional)
- [Trying it without a Firebase project](#trying-it-without-a-firebase-project)
- [Data protection in brief](#data-protection-in-brief)
<!-- /contents -->

## What you need

A computer with Python 3.12 or 3.13 and Node.js 20 or later (Node.js provides the `npx` command
that runs Firebase's own tool), a Google account, a payment card for Firebase's pay-as-you-go plan,
and the recordings of the study.

## 1. Install the administrator's tools

Download ElectroTag (clone the repository, or download and unpack its source archive): the
deployment in step 8 uses its files. ElectroTag's Python package is installed from this copy, since
it is not on PyPI. In a terminal in its folder, make a virtual environment for it, activate it and
install the package.

macOS and Linux (Terminal):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e .
electrotag web --help
```

Windows (PowerShell):

```powershell
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
pip install -e .
electrotag web --help
```

If PowerShell says that running scripts is disabled, allow scripts you have made yourself once with
`Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` and activate again; the same
setting lets PowerShell run `npx` in step 8. The
[README](../README.md#installing-the-python-package) explains each line. In a new terminal later
on, only the activation line is needed again. The last command lists everything `electrotag web`
can do. Every command used below also has its own help, for example
`electrotag web add-user --help`.

## 2. Create the Firebase project

Open the [Firebase console](https://console.firebase.google.com/), choose **Create a project** and
give it a name. Firebase proposes a project ID (for example `my-eeg-study`); note it down, because
every command needs it, and the application will be published at
`https://my-eeg-study.web.app`. Google Analytics is not needed and can be switched off.

## 3. Choose the pay-as-you-go plan and set a budget alert

Cloud Functions need Firebase's **Blaze** plan. In the console, open the plan shown at the bottom of
the left-hand menu (or **Usage and billing**) and choose Blaze, with a billing account. Blaze keeps
the free allowances of the no-cost plan; a small study usually costs little or nothing, but set a
budget so that you hear about it if not: in the [Google Cloud console](https://console.cloud.google.com/billing),
open **Billing**, then **Budgets and alerts**, and create a budget for the project (for example
£10 a month) with email alerts at 50 %, 90 % and 100 %. A budget sends warnings; it does not stop
the project.

## 4. Create the Firestore database in London

In the Firebase console's left-hand menu, open **Databases and Storage**, then **Firestore**, and
choose **Create database**. For the location choose **europe-west2 (London)**; it cannot be changed later. Start in
**production mode**: ElectroTag's rules (step 8) deny every direct access from browsers anyway.

## 5. Turn on sign-in with email and password

In the left-hand menu, open **Security**, then **Authentication**, and choose **Get started**.
Then, under **Sign-in method**, enable **Email/Password** (the first switch only; the passwordless
email link is not used). Nothing else needs setting: the project's own addresses,
`my-eeg-study.web.app` and `my-eeg-study.firebaseapp.com`, are allowed to sign people in from the
start, so the application published in step 8 works without further settings.

## 6. Register the web application and its website

Go to the project's overview page (**Project overview** at the top of the left-hand menu). Under
the project's name, choose **Add app**, then **Web** (the `</>` icon), and give it any nickname. Tick **Also set up Firebase Hosting for this app**, which
gives the project its website, and choose **Register app**. Firebase then shows a configuration
block and instructions for installing its tool and deploying; choose **Next** through them and
**Continue to console**, since step 8 does all of this for you. There is nothing to copy: once the
application is published from this project, it reads these settings from the project's website
itself. They identify the project to browsers and are not secret; what protects the study is that
every request goes through ElectroTag's functions, which check who is signed in.

## 7. A key for the administrator's command

`electrotag web` works on the project with a service account key. In **Project settings**,
**Service accounts**, choose **Generate new private key** and save the file somewhere private
(not in a shared or synchronised folder). It gives full access to the project: keep it like a
password, and delete it from the console if it is ever lost. Then tell the command where it is,
in each terminal you use.

macOS and Linux (Terminal):

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/my-eeg-study-key.json
```

Windows (PowerShell):

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\my-eeg-study-key.json"
```

## 8. Deploy the rules, the functions and the application

In the ElectroTag folder, sign in to Firebase's tool with your Google account, name your project,
prepare the functions' own Python environment (Firebase reads it to find the functions) and
deploy. The second line makes the file `.firebaserc`: open it in a text editor and replace
`YOUR-FIREBASE-PROJECT-ID` with your project ID before running the lines after it.

macOS and Linux (Terminal):

```bash
npx firebase-tools login
cp .firebaserc.template .firebaserc
python3.13 -m venv electrotag/web/firebase/functions/venv
electrotag/web/firebase/functions/venv/bin/python -m pip install -r electrotag/web/firebase/functions/requirements.txt
npx firebase-tools deploy --only "functions,firestore,hosting"
```

Windows (PowerShell):

```powershell
npx firebase-tools login
Copy-Item .firebaserc.template .firebaserc
py -3.13 -m venv electrotag\web\firebase\functions\venv
electrotag\web\firebase\functions\venv\Scripts\python -m pip install -r electrotag\web\firebase\functions\requirements.txt
npx firebase-tools deploy --only "functions,firestore,hosting"
```

Keep the quotation marks around `functions,firestore,hosting`: without them PowerShell splits the
list at the commas and deploys only part of it. Before uploading, the deployment copies the
ElectroTag code the functions need into their folder (`scripts/vendor_functions.py`, started by
`scripts/predeploy_functions.mjs` with the functions' own Python, on every system).

The first deployment takes several minutes, because Google switches on the services the functions
use and builds every function. On a new project it is common for some functions to fail on this
first attempt, with messages about a quota, "429" or "Too Many Requests", or a project that failed
to initialise: Google limits how many functions a new project may create at once while those
services start. Wait a few minutes and run the same `deploy` line again; the functions already in
place are skipped when nothing in them has changed, and the missing ones are created.

When it ends, the deployment prints the **Hosting URL**, `https://my-eeg-study.web.app`, where the
application now lives. Check three things in the console. The **Functions** page lists ElectroTag's twenty-six functions, whose names start with `et_`, all in europe-west2;
`et_admin`, which answers the admin area, has more memory and time than the others for the
analyses, and `et_expert`, which answers the expert area, a little more than the rest for saving
experts' corrections. **Firestore Database**, **Rules**, shows ElectroTag's rules, which deny all
direct access, in place of the default ones. **Hosting** shows a release published a moment ago.

Finally, check that every function is open to the application:

```
electrotag web check-functions --firebase-project my-eeg-study
```

The command asks each of the twenty-six functions from outside, as a browser does, and lists any
that Google turns away. Every function must be open to the public, because each one checks for
itself who is signed in and what they may do. Firebase's tool opens a function when it creates it,
and later deployments leave that setting as it is, so a function that was created while Google was
slowing down the first deployment can stay closed: the application then signs a person in and stops
with a message that the study's server turned the request away. The command prints, for each
closed function, the Google Cloud command (`gcloud`, from
[Google Cloud's command-line tools](https://cloud.google.com/sdk/docs/install)) that opens it, for
example

```
gcloud functions add-invoker-policy-binding et_me --region=europe-west2 --member=allUsers --project=my-eeg-study
```

or the same in the Google Cloud console: **Cloud Run**, the function's service (its name with
hyphens, such as `et-me`), **Security**, then **Allow public access**. Each function needs opening
only once; run the check again afterwards.

Deploy again with the same `deploy` line after updating ElectroTag, so that the functions and the
application stay at the same version (or use the GitHub workflow at the end of this guide).

## 9. Create the study

One Firebase project can hold several studies. Give each an ID of letters, digits, dots, hyphens
or underscores:

```
electrotag web init-study --firebase-project my-eeg-study --study pilot --name "Pilot study"
```

Settings that differ from ElectroTag's defaults (fixed display filters, the artifact types on the
number keys, how the next recording is chosen, interaction logging) are changed later in the admin
area. They can also be given as a JSON file with `--settings settings.json`, in the form of the
`settings` block of ElectroTag's study file, `electrotag_study.json` (docs/file_formats.md);
`--update` changes them.

## 10. Create your own administrator account

Each person has an ID within the study (for example A01) and signs in with their email address.
Start with yourself as administrator:

```
electrotag web add-user ADMIN --email you@example.ac.uk --admin --firebase-project my-eeg-study --study pilot
```

Without `--password` the command prints a link with which you choose your password. Open it in
your browser: a Firebase page asks for a new password, and after **Save** it says that you can now
sign in with it. The link works once; run the command again for a new one. This is the one account
that has to be made with the command: once you can sign in to the admin area, it makes the others.

## 11. Sign in to the application

Open the study's link in your browser: the application's address followed by `?study=` and the
study ID, for example

```
https://my-eeg-study.web.app/?study=pilot
```

The page shows **Sign in**, with **Study: pilot** under it and two fields, **Email address** and
**Password**. Enter the email address you gave in step 10 and the password you chose with its
link, then choose **Sign in**. An administrator goes straight to the admin area; the header offers
**My recordings**, to annotate as anyone else does, and **Admin**, to come back. Bookmark the link:
it is the same one you send to the study's annotators in step 13.

A link without `?study=` (just `https://my-eeg-study.web.app`) works too, for an account that
belongs to one study of the project: the sign-in page then says that your study opens once you sign
in, and the application opens that study. An account in several studies of the project needs the
link that names the study. Sign-in lasts as long as the browser tab: closing the tab signs you out,
and **Forgot password?** on the sign-in page emails a link for a new password.

If the page offers the demonstration, or asks for a study address, rather than an email address,
the application has not found the project's settings. Open
`https://my-eeg-study.web.app/__/firebase/init.json`: it should show your project ID among a few
other values. If it does not, check that step 6 registered a web app with Hosting and deploy again
(step 8). If signing in says that the email address or password is not right, check them, and make
a new password link with the command of step 10 if the first one was used or lost. If it says
instead that they were accepted but the study could not be opened because its server turned the
request away, the password is fine and some functions are closed: run
`electrotag web check-functions` (step 8) and open the ones it lists.

## 12. Set the study up in the admin area

Signed in as in step 11, you use the admin area (docs/admin_area.md explains each part) to:

* **add the recordings**: choose the dataset folder on your computer. The browser reads each
  recording there, runs ElectroTag's checks and sends only what the study needs to show the
  recording and recognise the annotator's file (its checksum, timing, channels and events); no EEG
  is uploaded, and the study checks again everything it receives;
* **make the accounts**: give each person an ID, a name and the email address they sign in with.
  The admin area shows a link with which they choose their own password; send it to them. You can
  disable an account (it can no longer sign in, at once), give a new link, change its roles
  (annotator, expert, administrator; one person may hold several), or remove someone from the
  study (their results and logs stay). Each person's roles in the study are written into their
  Firebase Authentication claims, and the functions also read the account in the study: an expert's
  or administrator's role counts only when both say so, so a role taken away counts at once and one
  just given counts once the person's browser renews its sign-in (within the hour, or at their next
  sign-in);
* **assign the work**: recordings to annotate, or a training programme;
* **build reference sets** for training and assessment: from an expert's saved annotations, an
  uploaded annotation file (an `_annotations.json`), a consensus of several experts or an adjudicator's final annotations, with
  their uses, the guided notes, the practice pass mark, the competency criteria and a short-segment
  quiz. *Add the example set* adds ElectroTag's simulated example set and gives you its
  recordings as a zip to pass on to trainees;
* **confirm the settings chosen before the study starts**: the Overview's *Before the study starts*
  lists the agreement settings (saved as the study's on the Analyses page), the working time the
  study reports (Study settings), the repeat ratings (Repeat ratings) and the training standards
  (each training set's pass mark and competency criteria, in Training, or *Confirm: no training*
  for a study without training). Choose each, then press
  its *Confirm*, before the first annotator saves a recording; the confirmations go into the
  results download;
* **change the settings**, follow the **progress**, run the **agreement**, **activity** and
  **competency** analyses, download the **results** (up to 25 MB; larger studies use step 14) and
  read the **audit log** of every change, with who made it and when.

Each of these can also be done from the command line, and the audit log records those changes too
(by "command"). Registration from the command line opens every recording with ElectroTag's
loader (`electrotag/app/eeg/loading.py`, which reads the files with MNE-Python), on the computer
that holds the recordings; training reference sets in the dataset
(`derivatives/electrotag_reference_sets/`) are stored too, with their experts' annotations but
without their recordings. The dataset's folder is written in each system's own way.

macOS and Linux (Terminal):

```bash
electrotag web register /data/Pilot --firebase-project my-eeg-study --study pilot
```

Windows (PowerShell):

```powershell
electrotag web register C:\data\Pilot --firebase-project my-eeg-study --study pilot
```

The other commands are the same on both:

```
electrotag web create-example-set --firebase-project my-eeg-study --study pilot --recordings-to ./example-set
electrotag web add-user A01 --email a01@example.ac.uk --name "Annotator one" --firebase-project my-eeg-study --study pilot
electrotag web assign A01 --all --firebase-project my-eeg-study --study pilot
electrotag web assign A02 --recordings sub-001/eeg/sub-001_task-rest_eeg.vhdr --firebase-project my-eeg-study --study pilot
electrotag web assign T01 --programme example --firebase-project my-eeg-study --study pilot
```

`electrotag web list --firebase-project my-eeg-study --study pilot` shows what the study holds.
When the computer with the recordings cannot reach the Internet, `export-manifests` writes the
registrations to a file and `import-manifests` stores them from another computer. To save typing,
name the project and the study once in the terminal; the options can then be left out.

macOS and Linux (Terminal):

```bash
export ELECTROTAG_FIREBASE_PROJECT=my-eeg-study
export ELECTROTAG_STUDY=pilot
```

Windows (PowerShell):

```powershell
$env:ELECTROTAG_FIREBASE_PROJECT = "my-eeg-study"
$env:ELECTROTAG_STUDY = "pilot"
```

The example set's recordings are simulated by ElectroTag itself. The Cloud Functions do not
include MNE-Python, so for them ElectroTag keeps the registrations of those recordings
(`electrotag/config/example_set_manifests.json`) and checks every file it makes against them
before adding the set; should they ever differ, the admin area says so and
`electrotag web create-example-set` adds the set instead.

## 13. Send the link and the recordings

Send each annotator the study's link from step 11 (for example
`https://my-eeg-study.web.app/?study=pilot`), their password link from step 12, and their
recordings, in the way your data protection arrangements require (for example on an encrypted
drive). They open the password link, choose a password, then open the study's link and sign in as
in step 11; they see their list and open each recording from their own disk. ElectroTag checks
that the file is the registered one before they start, and keeps a draft of unfinished work.

Follow progress in the admin area, or with `electrotag web progress --firebase-project my-eeg-study
--study pilot`, which lists each annotator's recordings (to do, in progress or done, with the time of
their last activity) and their training stages.

## 14. Export the results for the analyses

macOS and Linux (Terminal):

```bash
electrotag web export --firebase-project my-eeg-study --study pilot --to ~/Pilot-results
electrotag agreement ~/Pilot-results/Annotated_Events
electrotag activity ~/Pilot-results/Annotated_Events
```

Windows (PowerShell):

```powershell
electrotag web export --firebase-project my-eeg-study --study pilot --to $HOME\Pilot-results
electrotag agreement $HOME\Pilot-results\Annotated_Events
electrotag activity $HOME\Pilot-results\Annotated_Events
```

The export writes `Annotated_Events/` in ElectroTag's results layout: per annotator and
recording the five result files (written by ElectroTag's own code when each recording was saved),
the completion register, the training progress, the competency reports, the quiz results and
`interaction_logs/`, with beside each saved recording its own part of the interaction logs
(`_interaction_log.jsonl`, docs/file_formats.md). The admin area's results zip holds the same files. Run it again whenever you
like; it adds what is new and never replaces a file with different contents.

## Coming back to a study later

Once a study is set up, most of its day-to-day work needs only the browser. Sign in at the study's
link (step 11) and use the admin area to make accounts and new password links, change roles, add
recordings, assign work, follow progress and download the results. The terminal is needed for the
commands of this guide: exporting a large study's results (step 14), making the first
administrator of a new study in the same project (steps 9 and 10), checking the functions, and
updating ElectroTag. A new terminal remembers nothing from the last one, so it needs the
following each time, on the same computer where steps 1 and 7 were done.

**Open the terminal in the ElectroTag folder and activate its environment.** Use the folder you
downloaded in step 1; on Windows, keep the quotation marks, which a folder name with spaces needs.

macOS and Linux (Terminal):

```bash
cd ~/ElectroTag
source .venv/bin/activate
```

Windows (PowerShell):

```powershell
cd "C:\Users\you\Documents\ElectroTag"
.venv\Scripts\activate
```

The prompt then starts with `(.venv)`. If PowerShell says that running scripts is disabled, use
the `Set-ExecutionPolicy` line of step 1 once and activate again.

**Name the key, the project and the study.** The key is the file saved in step 7; naming the
project and the study here lets every command below leave out `--firebase-project` and `--study`.

macOS and Linux (Terminal):

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/my-eeg-study-key.json
export ELECTROTAG_FIREBASE_PROJECT=my-eeg-study
export ELECTROTAG_STUDY=pilot
```

Windows (PowerShell):

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\my-eeg-study-key.json"
$env:ELECTROTAG_FIREBASE_PROJECT = "my-eeg-study"
$env:ELECTROTAG_STUDY = "pilot"
```

To save typing next time, keep these lines in a text file and paste them in, with your own path,
project and study. A project with several studies is worked on one study at a time: set
`ELECTROTAG_STUDY` again to move to another.

**Check that everything is in place.** This command lists what the study holds:

```
electrotag web list
```

If the terminal does not know the command `electrotag`, the environment is not active: run the
activation line again. If the command cannot find or use the key, check the path to it; a key
that is lost can be replaced by generating a new one (step 7) and deleting the old one in the same
place in the console. A study ID that does not exist is reported as such: check
`ELECTROTAG_STUDY`.

**Then use the commands as before.** For example, to give a new annotator an account and their
recordings, see who has done what, and export the results:

```
electrotag web add-user A02 --email a02@example.ac.uk --name "Annotator two"
electrotag web assign A02 --all
electrotag web progress
electrotag web export --to Pilot-results
```

`add-user` prints the link with which the person chooses their password, as in step 10; send it
with the study's link (step 13). Every command lists its options with `--help`, for example
`electrotag web assign --help`.

**Updating ElectroTag.** When a newer version of ElectroTag is out, update your copy, the Python
package and the functions' environment, deploy again (step 8) and check the functions. Deploying
also publishes the new version of the application, so everyone signing in from then on uses it.

macOS and Linux (Terminal):

```bash
git pull
pip install -r requirements.txt
pip install -e .
electrotag/web/firebase/functions/venv/bin/python -m pip install -r electrotag/web/firebase/functions/requirements.txt
npx firebase-tools deploy --only "functions,firestore,hosting"
electrotag web check-functions
```

Windows (PowerShell):

```powershell
git pull
pip install -r requirements.txt
pip install -e .
electrotag\web\firebase\functions\venv\Scripts\python -m pip install -r electrotag\web\firebase\functions\requirements.txt
npx firebase-tools deploy --only "functions,firestore,hosting"
electrotag web check-functions
```

If `git pull` stops because a file was changed on this computer, `git status` names it, and
`git restore` followed by its name puts back the downloaded version, so that the pull can go on.
If ElectroTag was downloaded as a source archive rather than cloned, download and unpack the new
archive instead, then run the other lines in its folder after making its environment as in step 1.
Firebase's tool keeps your sign-in from step 8; if it says that you are not signed in or that the
sign-in has expired, run `npx firebase-tools login --reauth` and deploy again.

## Deploying updates from GitHub (optional)

After the first deployment from your computer, later ones can run on GitHub. In the
[Google Cloud console](https://console.cloud.google.com/iam-admin/serviceaccounts), for the project,
create a service account for deployments and give it the roles **Cloud Functions Developer**,
**Service Account User**, **Firebase Rules Admin**, **Cloud Datastore Index Admin** and
**Firebase Hosting Admin** (the roles the [firebase-action](https://github.com/w9jds/firebase-action)
documentation lists for these deployments), then create a JSON key for it. In the GitHub repository, under
**Settings**, **Secrets and variables**, **Actions**, add the key as the secret
`FIREBASE_SERVICE_ACCOUNT` and the project ID as the variable `FIREBASE_PROJECT`. The workflow
**Firebase deploy** (Actions tab, Run workflow) then deploys the functions, the rules, the
application or all three; without the secret it only explains what is missing.

## Publishing the application elsewhere (optional)

Firebase Hosting is the simplest home for a study's application, because it gives the application
its project's settings by itself. The same application can also be published on another website,
such as a fork of the repository on GitHub Pages or a university web server. It then reads a
`config.json` beside its `index.html`, which names the project and the default study, and takes
precedence over the project's own settings.

To write one, copy the project's configuration from the console (**Project settings**, **Your
apps**, the web app, **SDK setup and configuration**, **Config**) into a text file, for example
`firebase-config.txt`, and run:

```
electrotag web config --firebase-project my-eeg-study --study pilot --web-config firebase-config.txt --out config.json
```

Put `config.json` beside the application's files on that website, and add the website's address
under **Authentication**, **Settings**, **Authorized domains** so that people can sign in there.
ElectroTag's own repository never holds a `config.json` (`.gitignore` leaves it out, and Firebase
Hosting does not publish one), so that each project's settings stay with that project; its GitHub
Pages site, `https://faisalmushtaq.github.io/ElectroTag/`, opens the demonstration. A link can name
another study of the same project with `?study=<id>`.

## Trying it without a Firebase project

`electrotag web demo` runs the whole system on your computer with the ElectroTag server instead
of Firebase (docs/server.md). `scripts/test_firebase_emulators.sh` runs ElectroTag's tests of
the Firebase side on Google's Firebase Emulator Suite, which needs Java but no Firebase project.
`scripts/test_web_firebase.sh` goes further: on the same emulators it sets up a study with the
commands above, then drives the application in Chromium (signing in with an email address,
opening a recording from disk, saving it, guided training, a practice recording and its review) and
exports the results. Both scripts run in a Bash terminal: on macOS and Linux, and on Windows in the
Windows Subsystem for Linux. To try the application by hand on the emulators, give `config.json` an
`"emulators"` entry beside the usual ones:
`"emulators": {"auth": "http://127.0.0.1:9099", "functions": "127.0.0.1:5001"}` (never in a
published `config.json`).

## Data protection in brief

Firestore holds, for each study: the registrations of the recordings (checksums, timing, channel
names, events; no EEG), the training sets' expert annotations, the annotators' IDs, names, email
addresses, roles and the administrators' notes about them, their answers to the sign-up
questionnaire (by annotator ID, with every earlier set) and, kept apart from them, the full name and
contact details they gave (collections `questionnaires` and `contacts`), their drafts, their saved
results, training progress and quiz answers, the interaction logs (times, clicks, keys and what was on
screen; never typed text or passwords) and the audit log of the administrators' changes (which
never holds a password or a password link). Firebase Authentication holds each
person's email address and a hash of their password. The study's records are all in Google's
London region, in a project only you administer; browsers can read or write none of them directly.
Firebase Hosting holds only the application's own files, the same for every study and free of any
study data, and serves them from Google's network worldwide. Firestore holds no
EEG: annotators open the recordings from their own computers, or from a Dropbox or OneDrive link
that their browser reads straight from that service, and neither the file nor the link reaches
Firebase. The EEG stays on the device: copies kept there, to open a recording again without
downloading it, live in the browser's storage for the site until the annotator removes them or the
browser clears the site's data. To end a study, export
the results, then delete its data in the console (Firestore, `studies/<id>`) and its users
(Authentication), or delete the whole project.
