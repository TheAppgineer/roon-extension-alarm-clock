# roon-extension-alarm-clock

Roon Extension to start or stop playback on a specific zone at a specific time.

------------

## Installation

1. Install Node.js from https://nodejs.org.

   * On Windows, install from the above link.
   * On Mac OS, you can use [homebrew](http://brew.sh) to install Node.js.
   * On Linux, you can use your distribution's package manager, but make sure it installs a recent Node.js. Otherwise just install from the above link.

   Make sure you are running node 5.x or higher. This can be verified on the command line with the following command:

   ```sh
   node -v
   ```

   For example:

   ```sh
   $ node -v
   v5.10.1
   ```

1. Install Git from https://git-scm.com/downloads.
   * Following the instructions for the Operating System you are running.

1. Download the Alarm Clock extension.

   * Go to the [roon-extension-alarm-clock](https://github.com/TheAppgineer/roon-extension-alarm-clock) page on [GitHub](https://github.com).
   * Click the green 'Clone or Download' button and select 'Download ZIP'.

1. Extract the zip file in a local folder.

1. Change directory to the extension in the local folder:
    ```
    cd <local_folder>/roon-extension-alarm-clock
    ```
    *Replace `<local_folder>` with the local folder path.*

1. Install the dependencies:
    ```bash
    npm install
    ```

1. Run it!
    ```bash
    node .
    ```

    The extension should appear in Roon now. See Settings->Setup->Extensions and you should see it in the list. If you have multiple Roon Cores on the network, all of them should see it.

## Notes
* Automatic startup at system start is OS dependent and outside the scope of this document.
* Since you probably want to have this extension running 24/7, the most logical place for installation is on the system on which your Roon Core is running.
