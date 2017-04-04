// Copyright 2017 The Appgineer
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

"use strict";

var RoonApi          = require("node-roon-api"),
    RoonApiSettings  = require('node-roon-api-settings'),
    RoonApiStatus    = require('node-roon-api-status'),
    RoonApiTransport = require('node-roon-api-transport');

const EXPECTED_CONFIG_REV = 1;
const ALARM_COUNT = 5;

const ACTION_NONE = -1;
const ACTION_STOP = 0;
const ACTION_PLAY = 1;
const ACTION_TRANSFER = 2;

const SUN     = 0;
const MON     = 1;
const TUE     = 2;
const WED     = 3;
const THU     = 4;
const FRI     = 5;
const SAT     = 6;
const ONCE    = 7;
const DAILY   = 8;
const MON_FRI = 9;
const WEEKEND = 10;

var core = null;
var wake_zone = [];
var timeout_id = [];
var interval_id = [];
var fade_volume = [];

var roon = new RoonApi({
    extension_id:        'com.theappgineer.alarm-clock',
    display_name:        'Alarm Clock',
    display_version:     '0.2.0',
    publisher:           'The Appgineer',
    email:               'theappgineer@gmail.com',
    website:             'https://github.com/TheAppgineer/roon-extension-alarm-clock',

    core_paired: function(core_) {
        core = core_;
        core.services.RoonApiTransport.subscribe_zones(function(response, msg) { });
    },
    core_unpaired: function(core_) {
        core = undefined;
    }
});

var wake_settings = roon.load_config("settings") || {
    selected_timer: 0
};

function makelayout(settings) {
    var l = {
        values:    settings,
        layout:    [],
        has_error: false
    };
    let selector = {
        type:    "dropdown",
        title:   "Selected Alarm",
        values:  [],
        setting: "selected_timer"
    };

    for (let i = 0; i < ALARM_COUNT; i++) {
        selector.values.push({
            title: get_alarm_title(settings, i),
            value: i
        });
    }
    l.layout.push(selector);

    let i = settings.selected_timer;
    let group = {
        type:        "group",
        items:       [],
    };
    group.title = selector.values[i].title;

    group.items.push({
        type:    "dropdown",
        title:   "Timer",
        values:  [
            { title: "Disabled", value: false },
            { title: "Enabled",  value: true  }
        ],
        setting: "timer_active_" + i
    });

    if (settings["timer_active_" + i]) {
        let v = {
            type:    "zone",
            title:   "Zone",
            setting: "zone_" + i
        };
        group.items.push(v);

        let zone = settings["zone_" + i];
        let current_volume = null;

        if (zone) {
            // Get volume information from output
            current_volume = get_current_volume(zone.output_id);

            if (current_volume && settings["wake_volume_" + i] == null) {
                settings["wake_volume_" + i] = current_volume.max;
            }
        }

        group.items.push({
            type:    "dropdown",
            title:   "Action",
            values:  [
                { title: "Stop",     value: ACTION_STOP     },
                { title: "Play",     value: ACTION_PLAY     },
                { title: "Transfer", value: ACTION_TRANSFER }
            ],
            setting: "wake_action_" + i
        });

        v = {
            type:    "dropdown",
            title:   "Day(s)",
            values:  [
                { title: "Once",               value: ONCE    },
                { title: "Daily",              value: DAILY   },
                { title: "Monday till Friday", value: MON_FRI },
                { title: "Weekend",            value: WEEKEND },
                { title: "Sunday",             value: SUN },
                { title: "Monday",             value: MON },
                { title: "Tuesday",            value: TUE },
                { title: "Wednesday",          value: WED },
                { title: "Thursday",           value: THU },
                { title: "Friday",             value: FRI },
                { title: "Saturday",           value: SAT }
            ],
            setting: "wake_day_" + i
        };
        group.items.push(v);

        let day = settings["wake_day_" + i];
        let allow_rel_timer = 0;

        if (day == ONCE) {
            // 'Once' implies no repeat
            settings["repeat_" + i] = false;
            allow_rel_timer = 1;
        }

        v = {
            type:    "string",
            title:   "Alarm Time",
            setting: "wake_time_" + i
        };
        group.items.push(v);

        let valid_time = validate_time_string(settings["wake_time_" + i], allow_rel_timer);

        if (valid_time) {
            settings["wake_time_" + i] = valid_time.friendly;
        } else {
            if (allow_rel_timer) {
                v.error = "Time should conform to format: [+]hh:mm[am|pm]";
            } else {
                v.error = "Time should conform to format: hh:mm[am|pm]";
            }
            l.has_error = true;
        }

        if (zone && settings["wake_action_" + i] != ACTION_STOP) {
            if (current_volume) {
                let v = {
                    type:    "integer",
                    min:     current_volume.min,
                    max:     current_volume.max,
                    title:   "Volume",
                    setting: "wake_volume_" + i
                };
                let volume = settings["wake_volume_" + i];
                if (current_volume.type == "db") {
                    v.title += " (dB)"
                }
                if (volume < v.min || volume > v.max) {
                    v.error = "Wake Volume must be between " + v.min + " and " + v.max + ".";
                    l.has_error = true;
                }
                group.items.push(v);
            }
        }

        if (settings["wake_action_" + i] != ACTION_TRANSFER) {
            v = {
                type:    "integer",
                min:     0,
                max:     30,
                title:   "Fade Time",
                setting: "fade_time_" + i
            };
            let fade_time = settings["fade_time_" + i];
            if (fade_time < v.min || fade_time > v.max) {
                v.error = "Fade Time must be between " + v.min + " and " + v.max + " minutes.";
                l.has_error = true;
            }
            group.items.push(v);
        } else {
            v = {
                type:    "zone",
                title:   "Transfer Zone",
                setting: "transfer_zone_" + i
            };
            group.items.push(v);
        }

        // Hide repeat for 'Once'
        if (day != ONCE) {
            v = {
                type:    "dropdown",
                title:   "Repeat",
                values:  [
                    { title: "Disabled", value: false },
                    { title: "Enabled",  value: true  }
                ],
                setting: "repeat_" + i
            };
            group.items.push(v);
        }
    }

    l.layout.push(group);

    return l;
}

function set_defaults(settings, index, force) {
    if (force || settings["timer_active_" + index] == null) {
        settings["timer_active_"  + index] = false;
        settings["zone_"          + index] = null;
        settings["wake_action_"   + index] = ACTION_PLAY;
        settings["wake_day_"      + index] = ONCE;
        settings["wake_time_"     + index] = "07:00";
        settings["wake_volume_"   + index] = null;
        settings["fade_time_"     + index] = "0";
        settings["transfer_zone_" + index] = null;
        settings["repeat_"        + index] = false;

        return true;
    }

    return false;
}

function validate_config(settings) {
    const config_rev = settings["config_rev"];
    let corrected = false;

    for (let i = 0; i < ALARM_COUNT; i++) {
        if ((corrected = set_defaults(settings, i)) == false) {
            // Check for configuration updates
            switch (config_rev) {
                case undefined:
                    // Update to configuration revision 1
                    let wake_time = "" + settings["wake_time_hours_" + i] +
                                    ":" + settings["wake_time_minutes_" + i];

                    settings["wake_time_" + i] = wake_time;
                    corrected = true;
                    break;
                case EXPECTED_CONFIG_REV:
                    // This is the expected configuration revision
                    break;
                default:
                    // Configuration is too new, we have to revert to the defaults of this revision
                    corrected = set_defaults(settings, i, true);
                    break;
            }
        }
    }

    settings["config_rev"] = EXPECTED_CONFIG_REV;

    return corrected;
}

function get_alarm_title(settings, index) {
    const active = settings["timer_active_" + index];
    const zone = settings["zone_" + index];
    const day = settings["wake_day_" + index];
    let valid_time = validate_time_string(settings["wake_time_" + index], day == ONCE);
    let title;

    if (active && zone && valid_time) {
        const day_string = [
            " on Sunday",               // SUN
            " on Monday",               // MON
            " on Tueday",               // TUE
            " on Wednesday",            // WED
            " on Thursday",             // THU
            " on Friday",               // FRI
            " on Saturday",             // SAT
            "",                         // ONCE
            " daily",                   // DAILY
            " on Monday till Friday",   // MON_FRI
            " in weekend"               // WEEKEND
        ];
        const action = settings["wake_action_" + index];
        const transfer_zone = settings["transfer_zone_" + index];
        let repeat_string = "";
        let action_string = get_action_string(action);

        if (settings["repeat_" + index]) {
            switch (day) {
                case ONCE:
                case DAILY:
                    break;
                case MON_FRI:
                    repeat_string = " (weekly)";
                    break;
                default:
                    repeat_string = "s";    // Append 's' to day
                    break;
            }
        } else if (day == MON_FRI || day == DAILY) {
            repeat_string = " (this week)";
        }

        title = zone.name + ": " + action_string + day_string[day] + repeat_string;

        if (action == ACTION_TRANSFER && transfer_zone) {
            title += " to " + transfer_zone.name;
        }

        if (valid_time.relative) {
            title += "in " + (valid_time.hours ? valid_time.hours + "h and " : "");
            title += valid_time.minutes + "min";
        } else {
            title += " @ " + valid_time.friendly;
        }
    } else {
        title = "Alarm " + (index + 1) + " not set";
    }

    return title;
}

function get_action_string(action) {
    let action_string = "";

    switch (action) {
        case ACTION_STOP:
            action_string = "Stop";
            break;
        case ACTION_PLAY:
            action_string = "Play";
            break;
        case ACTION_TRANSFER:
            action_string = "Transfer";
            break;
    }

    return action_string;
}

function validate_time_string(time_string, allow_relative) {
    let relative = (time_string.charAt(0) == "+");

    if (relative && !allow_relative) {
        return null;
    }

    let valid_time_string = time_string.substring(relative);
    let separator_index = valid_time_string.indexOf(":");
    let hours = "0";

    // Extract hours
    if (separator_index == 1 || separator_index == 2 ) {
        hours = valid_time_string.substring(0, separator_index);
    } else if (relative) {
        // Outside expected range, no hours specified
        separator_index = -1;
    } else {
        return null;
    }

    // Extract minutes
    let minutes = valid_time_string.substring(separator_index + 1, separator_index + 3);

    // Check ranges
    if (isNaN(hours) || hours < 0 || hours > 23) {
        return null;
    }

    if (isNaN(minutes) || minutes < 0 || minutes > 59) {
        return null;
    }

    // Extract 24h/12h clock type
    let is_am = false;
    let is_pm = false;
    let am_pm = "";

    if (!relative) {
        let am_pm_index = separator_index + 1 + minutes.length;
        am_pm = valid_time_string.substring(am_pm_index, am_pm_index + 2);
        is_am = (am_pm.toLowerCase() == "am");
        is_pm = (am_pm.toLowerCase() == "pm");
        console.log(am_pm, is_am, is_pm, hours);

        // Check hour range
        if (is_am || is_pm) {
            if (hours < 1 || hours > 12) {
                return null;
            }
        }
    }

    if (hours.length == 1) {
        hours = "0" + hours;
    }

    if (minutes.length == 1) {
        minutes = "0" + minutes;
    }

    // Create human readable string
    let friendly = (relative ? "+" : "") + hours + ":" + minutes;
    if (is_am || is_pm) {
        friendly += am_pm;
    }

    // Convert to 24h clock type
    if (is_am && hours == 12) {
        hours -= 12;
    } else if (is_pm && hours < 12) {
        hours = +hours + 12;
    }

    return {
        relative: relative,
        hours:    +hours,
        minutes:  +minutes,
        friendly: friendly
    };
}

function set_timer() {
    let settings = wake_settings;
    let next_alarm_timeout = 0;
    let action_string;

    for (let i = 0; i < ALARM_COUNT; i++) {
        if (settings["timer_active_" + i] && settings["zone_" + i]) {
            const action = settings["wake_action_" + i];
            const wake_day = settings["wake_day_" + i];
            const fade_time = +settings["fade_time_" + i];    // string to integer
            let date = new Date();

            // Configuration is already validated at this point, get processed fields
            let valid_time = validate_time_string(settings["wake_time_" + i], wake_day == ONCE);

            date.setSeconds(0);
            date.setMilliseconds(0);

            let timeout_time = date.getTime();

            if (valid_time.relative) {
                timeout_time += (valid_time.hours * 60 + valid_time.minutes) * 60 * 1000;
            } else {
                let tz_offset = date.getTimezoneOffset();
                let day = date.getDay();
                let days_to_skip = 0;

                date.setHours(valid_time.hours);
                date.setMinutes(valid_time.minutes);
                timeout_time = date.getTime();

                if (fade_time && action == ACTION_PLAY) {
                    // Subtract fade time to reach the configured volume at the configured time
                    timeout_time -= fade_time * 60 * 1000;
                }

                if (wake_day < 7) {
                    days_to_skip = (wake_day + 7 - day) % 7;
                }

                if (days_to_skip == 0 && timeout_time < Date.now()) {
                    // Time has passed for today
                    if (wake_day < 7) {
                        // Next week
                        days_to_skip = 7;
                    } else {
                        // Tomorrow
                        days_to_skip = 1;
                        day = (day + 1) % 7;
                    }
                }

                if (wake_day == MON_FRI) {
                    switch (day) {
                        case SUN:
                            // Sunday
                            days_to_skip += 1;
                            break;
                        case SAT:
                            // Saterday
                            days_to_skip += 2;
                            break;
                    }
                } else if (wake_day == WEEKEND && day > SUN && day < SAT) {
                    days_to_skip += SAT - day;
                }

                timeout_time += days_to_skip * 24 * 60 * 60 * 1000;
                date = new Date(timeout_time);
                tz_offset -= date.getTimezoneOffset();

                if (tz_offset) {
                    timeout_time -= tz_offset * 60 * 1000;
                }
            }
            if (next_alarm_timeout == 0 || timeout_time < next_alarm_timeout) {
                next_alarm_timeout = timeout_time;
                action_string = (fade_time ? "Faded " : "");
                action_string += get_action_string(action);
            }
            timeout_time -= Date.now();

            if (timeout_id[i] != null) {
                // Clear pending timeout
                clearTimeout(timeout_id[i]);
            }

            timeout_id[i] = setTimeout(timer_timed_out, timeout_time, i);
        }
    }

    if (next_alarm_timeout) {
        // Report time of next alarm
        let date_time = new Date(next_alarm_timeout);
        let alarm_string = "Next Alarm (" + action_string + "):\n" + date_time.toString();

        svc_status.set_status(alarm_string, false);
    } else {
        // Update status
        svc_status.set_status("No active Alarms", false);
    }
}

function timer_timed_out(i) {
    let settings = wake_settings;
    let zone = settings["zone_" + i];

    timeout_id[i] = null;

    if (core) {
        let action = settings["wake_action_" + i];

        // Get wake_zone from settings.zone.output_id
        wake_zone[i] = core.services.RoonApiTransport.zone_by_output_id(zone.output_id);

        if (wake_zone[i] && (wake_zone[i].is_play_allowed || action != ACTION_PLAY)) {
            const fade_time = +settings["fade_time_" + i];
            let end_volume = settings["wake_volume_" + i];
            let current_volume = get_current_volume(zone.output_id);

            if (current_volume && action != ACTION_TRANSFER && fade_time > 0) {
                let start_volume;

                if (wake_zone[i].state == 'playing') {
                    start_volume = current_volume.value;
                } else {
                    start_volume = current_volume.min;
                }

                if (action == ACTION_STOP) {
                    end_volume = current_volume.min;
                }

                if (end_volume != start_volume) {
                    // Take care of fading
                    let ms_per_step = (fade_time * 60 * 1000) / Math.abs(end_volume - start_volume);

                    if (interval_id[i] != null) {
                        clearInterval(interval_id[i]);
                    }

                    interval_id[i] = setInterval(take_fade_step, ms_per_step,
                                                 i, start_volume, end_volume);

                    if (wake_zone[i].state == 'playing' && action == ACTION_STOP) {
                        // Remain playing during fade out
                        action = ACTION_NONE;
                    }

                    end_volume = start_volume;
                    fade_volume[i] = start_volume;
                }
            }

            switch (action) {
                case ACTION_PLAY:
                    // Set wake volume, even if already playing
                    core.services.RoonApiTransport.change_volume(zone, "absolute", end_volume);

                    if (wake_zone[i].state != 'playing') {
                        core.services.RoonApiTransport.control(zone, 'play');
                    }
                    break;
                case ACTION_STOP:
                    if (wake_zone[i].state == 'playing') {
                        core.services.RoonApiTransport.control(zone, 'pause');
                    }
                    break;
                case ACTION_TRANSFER:
                    let transfer_zone = settings["transfer_zone_" + i];

                    // Set volume for the zone we transfer to
                    core.services.RoonApiTransport.change_volume(transfer_zone, "absolute", end_volume);
                    core.services.RoonApiTransport.transfer_zone(zone, transfer_zone);
                    break;
                case ACTION_NONE:
                default:
                    break;
            }
        }
    }

    let date = new Date();
    let day = date.getDay();
    let wake_day = settings["wake_day_" + i];

    if (settings["repeat_" + i] == false &&
        ((wake_day <= ONCE) ||
         (wake_day == WEEKEND && day == SUN) ||
         (wake_day == MON_FRI && day == FRI) ||
         (wake_day == DAILY && day == SAT))) {
        // Disable this timer
        settings["timer_active_" + i] = false;
        roon.save_config("settings", settings);
    }

    set_timer();
}

function get_current_volume(output_id) {
    let zone = core.services.RoonApiTransport.zone_by_output_id(output_id);
    let volume = null;

    if (zone && zone.outputs) {
        zone.outputs.forEach(function(output) {
            if (output.output_id == output_id) {
                volume = output.volume;
            }
        });
    }

    return volume;
}

function take_fade_step(index, start_volume, end_volume) {
    let zone = wake_settings["zone_" + index];
    let step = (start_volume < end_volume ? 1 : -1);
    let current_volume = get_current_volume(zone.output_id);

    if (current_volume) {
        // Detect volume control collisions, allow for 1 step volume set back
        if (current_volume.value - fade_volume[index] > 1) {
            // Somebody else is turning the knob as well, hands off
            clearInterval(interval_id[index]);

            console.log("Fading terminated for alarm " + (index + 1));
        } else {
            if (fade_volume[index] != end_volume) {
                // Fade one step
                fade_volume[index] += step;
                core.services.RoonApiTransport.change_volume(zone, "absolute", fade_volume[index]);
            } else {
                // Level reached, clear interval
                clearInterval(interval_id[index]);

                if (end_volume == current_volume.min && wake_zone[index].state == 'playing') {
                    // Stop playback
                    core.services.RoonApiTransport.control(wake_zone[index], 'pause', function(error) {
                        if (error == false) {
                            // Restore start volume
                            core.services.RoonApiTransport.change_volume(zone, "absolute", start_volume);
                        }
                    });
                }
            }
        }
    }
}

function init() {
    for (let i = 0; i < ALARM_COUNT; i++) {
        wake_zone.push(null);
        timeout_id.push(null);
        interval_id.push(null);
        fade_volume.push(null);
    }

    if (validate_config(wake_settings)) {
        roon.save_config("settings", wake_settings);
    }

    set_timer();
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(makelayout(wake_settings));
    },
    save_settings: function(req, isdryrun, settings) {
        let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            wake_settings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", wake_settings);

            set_timer();
        }
    }
});

var svc_status = new RoonApiStatus(roon);

roon.init_services({
    required_services:   [ RoonApiTransport ],
    provided_services:   [ svc_settings, svc_status ]
});

init();
roon.start_discovery();
