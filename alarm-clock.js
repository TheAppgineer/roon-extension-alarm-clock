// Copyright 2017, 2018, 2019, 2020 The Appgineer
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
    RoonApiTransport = require('node-roon-api-transport'),
    RoonApiBrowse    = require('node-roon-api-browse'),
    ApiTimeInput     = require('node-api-time-input');

const EXPECTED_CONFIG_REV = 4;
const MAX_ALARM_COUNT = 20;

const ACTION_NONE = -1;
const ACTION_STOP = 0;
const ACTION_PLAY = 1;
const ACTION_TRANSFER = 2;
const ACTION_STANDBY = 3;

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

const TRANS_INSTANT    = 0;
const TRANS_FADING     = 1;
const TRANS_TRACKBOUND = 2;

const SRC_QUEUE          = 0;
const SRC_GENRE          = 1;
const SRC_PLAYLIST       = 2;
const SRC_INTERNET_RADIO = 3;

const source_strings = ['Queue', 'Genres', 'Playlists', 'Internet Radio'];
const activation_strings = [[], ['Play Genre', 'Shuffle'], ['Play Playlist', 'Shuffle'], []];

var core = undefined;
var transport = undefined;
var waiting_zones = {};
var pending_alarms = [];
var timeout_id = [];
var interval_id = [];
var fade_volume = [];
var source_entry_list = [];
var queried_profile;
var queried_source_type;
var profiles = [];
var active_profile;

var timer = new ApiTimeInput();

var roon = new RoonApi({
    extension_id:        'com.theappgineer.alarm-clock',
    display_name:        'Alarm Clock',
    display_version:     '0.7.5',
    publisher:           'The Appgineer',
    email:               'theappgineer@gmail.com',
    website:             'https://community.roonlabs.com/t/roon-extension-alarm-clock/21556',

    core_paired: function(core_) {
        core = core_;
        transport = core.services.RoonApiTransport;

        transport.subscribe_zones((response, msg) => {
            let zones = [];

            if (response == "Subscribed") {
                zones = msg.zones;

                select_profile(wake_settings, { multi_session_key: '0' });
                set_timer(true);
            } else if (response == "Changed") {
                if (msg.zones_changed) {
                    zones = msg.zones_changed;
                }
                if (msg.zones_added) {
                    zones = msg.zones_added;
                }
                if (msg.zones_seek_changed) {
                    zones = msg.zones_seek_changed;
                }
            }

            if (zones) {
                zones.forEach(function(zone) {
                    const on_match = waiting_zones[zone.zone_id];

                    if (on_match && on_match.properties) {
                        let match = false;

                        if (on_match.properties.now_playing) {
                            const seek_position = on_match.properties.now_playing.seek_position;

                            // Sometimes a seek_position is missed by the API, allow 1 off
                            match = (seek_position != undefined && zone.now_playing &&
                                     (seek_position == zone.now_playing.seek_position ||
                                      seek_position + 1 == zone.now_playing.seek_position));
                        }
                        if (!match) {
                            const play_allowed = on_match.properties.is_play_allowed;
                            const pause_allowed = on_match.properties.is_pause_allowed;
                            const state = on_match.properties.state;

                            match = ((play_allowed != undefined && play_allowed == zone.is_play_allowed) ||
                                     (pause_allowed != undefined && pause_allowed == zone.is_pause_allowed) ||
                                     (state != undefined && state == zone.state));
                        }
                        if (match) {
                            if (on_match.cb) {
                                on_match.cb(zone);
                            }
                            delete waiting_zones[zone.zone_id];
                        }
                    }
                });
            }
        });
    },
    core_unpaired: function(core_) {
        core = undefined;
        transport = undefined;
    }
});

var wake_settings = roon.load_config("settings") || {
    selected_timer: 0,
    alarm_count:    1,
    profile:        null
};

function on_zone_property_changed(zone_id, properties, cb) {
    waiting_zones[zone_id] = { properties: properties, cb: cb };
}

function makelayout(settings) {
    let l = {
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
    let used_alarms = 0;

    for (let i = 0; i < settings.alarm_count; i++) {
        selector.values.push({
            title: get_alarm_title(settings, i),
            value: i
        });

        if (settings["zone_" + i]) {
            used_alarms++;
        }
    }

    if (used_alarms == settings.alarm_count && used_alarms < MAX_ALARM_COUNT) {
        set_defaults(settings, settings.alarm_count++);

        selector.values.push({
            title: get_alarm_title(settings, used_alarms),
            value: used_alarms
        });
    }

    if (profiles.length > 1) {
        l.layout.push({
            type:    "dropdown",
            title:   "Profile",
            values:  profiles,
            setting: "profile"
        });
    }

    l.layout.push(selector);

    const i = settings.selected_timer;
    let alarm = {
        type:        "group",
        items:       []
    };
    let time = {
        type:        "group",
        title:       "Time",
        collapsable: true,
        items:       []
    };
    let place = {
        type:        "group",
        title:       "Place",
        collapsable: true,
        items:       []
    };
    let event = {
        type:        "group",
        title:       "Event",
        collapsable: true,
        items:       []
    };

    l.layout.push({
        type:    "dropdown",
        title:   "State",
        values:  [
            { title: "Inactive", value: false },
            { title: "Active",   value: true  }
        ],
        setting: "timer_active_" + i
    });

    if (settings["timer_active_" + i]) {
        // Time
        let v = {
            type:    "dropdown",
            title:   "Day(s)",
            values:  [
                { title: "Once",      value: ONCE    },
                { title: "Daily",     value: DAILY   },
                { title: "Weekdays",  value: MON_FRI },
                { title: "Weekend",   value: WEEKEND },
                { title: "Sunday",    value: SUN     },
                { title: "Monday",    value: MON     },
                { title: "Tuesday",   value: TUE     },
                { title: "Wednesday", value: WED     },
                { title: "Thursday",  value: THU     },
                { title: "Friday",    value: FRI     },
                { title: "Saturday",  value: SAT     }
            ],
            setting: "wake_day_" + i
        };
        time.items.push(v);

        v = {
            type:    "string",
            title:   "Time",
            setting: "wake_time_" + i
        };
        time.items.push(v);

        const day = settings["wake_day_" + i];
        let allow_rel_timer = 0;

        if (day == ONCE) {
            allow_rel_timer = 1;
            v.title += " (use '+' for relative alarm)";
        }

        const valid_time = timer.validate_time_string(settings["wake_time_" + i], allow_rel_timer);

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

        v = {
            type:    "dropdown",
            title:   "Repeat",
            values:  [
                { title: "Disabled", value: false }
            ],
            setting: "repeat_" + i
        };
        time.items.push(v);

        if (day == ONCE) {
            // 'Once' implies no repeat
            settings["repeat_" + i] = false;
        } else {
            v.values.push({ title: "Enabled",  value: true });
        }

        const output = settings["zone_" + i];
        let current_volume = null;

        if (output) {
            // Get volume information from output
            current_volume = get_current_volume_by_output_id(output.output_id);

            if (current_volume && settings["wake_volume_" + i] == null) {
                // Set volume to the max of the output
                settings["wake_volume_" + i] = current_volume.max;
            }
        }

        // Place
        v = {
            type:    "zone",
            title:   "Zone",
            setting: "zone_" + i
        };
        place.items.push(v);

        // Event
        event.items.push({
            type:    "dropdown",
            title:   "Action",
            values:  [
                { title: "Play",     value: ACTION_PLAY     },
                { title: "Stop",     value: ACTION_STOP     },
                { title: "Standby",  value: ACTION_STANDBY  },
                { title: "Transfer", value: ACTION_TRANSFER }
            ],
            setting: "wake_action_" + i
        });

        const action = settings["wake_action_" + i];

        if ((action == ACTION_PLAY || action == ACTION_TRANSFER) && current_volume) {
            const volume = settings["wake_volume_" + i];

            v = {
                type:    "integer",
                min:     current_volume.min,
                max:     current_volume.max,
                title:   "Volume",
                setting: "wake_volume_" + i
            };
            if (current_volume.type == "db") {
                v.title += " (dB)"
            }
            if (volume < v.min || volume > v.max) {
                v.error = "Volume must be between " + v.min + " and " + v.max + ".";
                l.has_error = true;
            }
            event.items.push(v);
        }

        if (action == ACTION_PLAY) {
            const source_type = {
                type:    "dropdown",
                title:   "Source",
                values:  [
                    { title: "Queue (DIY)",    value: SRC_QUEUE          },
                    { title: "Genre",          value: SRC_GENRE          },
                    { title: "Playlist",       value: SRC_PLAYLIST       },
                    { title: "Internet Radio", value: SRC_INTERNET_RADIO }
                ],
                setting: "source_type_" + i
            };
            event.items.push(source_type);

            if (settings["source_type_" + i] != SRC_QUEUE) {
                event.items.push({
                    type:    "dropdown",
                    title:   source_type.values[settings["source_type_" + i]].title,
                    values:  source_entry_list,
                    setting: "source_entry_" + i
                });
            }
        }

        const trans_time = settings["transition_time_" + i];
        let transition_type = {
            type:    "dropdown",
            title:   "Transition Type",
            values:  [ { title: "Instant", value: TRANS_INSTANT } ],
            setting: "transition_type_" + i
        };
        let transition_time = {
            type:    "integer",
            min:     0,
            max:     30,
            title:   "Transition Time [min]",
            setting: "transition_time_" + i
        };

        if (trans_time < transition_time.min || trans_time > transition_time.max) {
            transition_time.error = "Transition Time must be between " + transition_time.min +
                                    " and " + transition_time.max + " minutes.";
            l.has_error = true;
        }

        if (action == ACTION_TRANSFER) {
            v = {
                type:    "zone",
                title:   "Transfer Zone",
                setting: "transfer_zone_" + i
            };
            event.items.push(v);

            settings["transition_type_" + i] = TRANS_INSTANT;
        } else {
            if (current_volume) {
                transition_type.values.push({
                    title: "Fading",
                    value: TRANS_FADING
                });
            } else if (settings["transition_type_" + i] == TRANS_FADING) {
                settings["transition_type_" + i] = TRANS_INSTANT;
            }

            if (action == ACTION_STOP || action == ACTION_STANDBY) {
                transition_type.values.push({
                    title: "Track Boundary",
                    value: TRANS_TRACKBOUND
                });
            } else if (settings["transition_type_" + i] == TRANS_TRACKBOUND) {
                settings["transition_type_" + i] = TRANS_INSTANT;
            }

            event.items.push(transition_type);

            if (settings["transition_type_" + i] != TRANS_INSTANT) {
                event.items.push(transition_time);
            }
        }

        alarm.items.push(time);
        alarm.items.push(place);
        alarm.items.push(event);
    }

    alarm.title = selector.values[i].title;

    l.layout.push(alarm);

    return l;
}

function set_defaults(settings, index, force) {
    if (force || settings["timer_active_" + index] == null) {
        settings["timer_active_"    + index] = false;
        settings["zone_"            + index] = null;
        settings["wake_action_"     + index] = ACTION_PLAY;
        settings["wake_day_"        + index] = ONCE;
        settings["wake_time_"       + index] = "07:00";
        settings["wake_volume_"     + index] = null;
        settings["transition_type_" + index] = TRANS_INSTANT;
        settings["transition_time_" + index] = "3";
        settings["transfer_zone_"   + index] = null;
        settings["repeat_"          + index] = false;
        settings["source_type_"     + index] = SRC_QUEUE;
        settings["source_entry_"    + index] = null;

        return true;
    }

    return false;
}

function validate_config(settings) {
    const config_rev = settings["config_rev"];
    let corrected = false;
    let alarm_count;

    if (config_rev <= 2) {
        alarm_count = 5;
    } else {
        alarm_count = settings.alarm_count;
    }

    for (let i = alarm_count - 1; i >= 0; i--) {
        if ((corrected = set_defaults(settings, i)) == false) {
            // Check for configuration updates
            switch (config_rev) {
                case undefined:
                    // Update to configuration revision 1
                    const wake_time = "" + settings["wake_time_hours_" + i] +
                                      ":" + settings["wake_time_minutes_" + i];

                    settings["wake_time_" + i] = wake_time;

                    // Fall through
                case 1:
                    const fade_time = settings["fade_time_" + i];

                    settings["transition_type_" + i] = (fade_time > 0 ? TRANS_FADING : TRANS_INSTANT);
                    settings["transition_time_" + i] = fade_time;

                    // Cleanup obsolete settings
                    delete settings["wake_time_hours_" + i];
                    delete settings["wake_time_minutes_" + i];
                    delete settings["fade_time_" + i];

                    // Fall through
                case 2:
                    // Convert the fixed alarm count to the dynamic variant
                    if (settings.alarm_count == undefined) {
                        if (settings["zone_" + i] == null) {
                            // Remove never used alarms
                            alarm_count--;
                        } else {
                            // We found the last alarm that had been used, set alarm count to 'used + 1'
                            settings.alarm_count = alarm_count + 1;
                        }
                    }

                    // Fall through
                case 3:
                    if (settings.profile === undefined) {
                        settings["profile"] = null;
                    }

                    settings["source_type_"  + i] = SRC_QUEUE;
                    settings["source_type_"  + i] = SRC_QUEUE;
                    settings["source_entry_" + i] = null;

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

    if (settings.alarm_count == undefined) {
        settings.alarm_count = alarm_count + 1;
    }

    settings.config_rev = EXPECTED_CONFIG_REV;

    return corrected;
}

function get_alarm_title(settings, index) {
    const active = settings["timer_active_" + index];
    const zone = settings["zone_" + index];
    const day = settings["wake_day_" + index];
    let valid_time = timer.validate_time_string(settings["wake_time_" + index], day == ONCE);
    let title;

    if (active && zone && valid_time) {
        const day_string = [
            " on Sunday",     // SUN
            " on Monday",     // MON
            " on Tueday",     // TUE
            " on Wednesday",  // WED
            " on Thursday",   // THU
            " on Friday",     // FRI
            " on Saturday",   // SAT
            "",               // ONCE
            " daily",         // DAILY
            " on weekdays",   // MON_FRI
            " on the weekend" // WEEKEND
        ];
        const action = settings["wake_action_" + index];
        const source_type = settings["source_type_" + index];
        const source_entry = settings["source_entry_" + index];
        const source = (source_type == SRC_QUEUE ? null : source_entry);
        const transfer_zone = settings["transfer_zone_" + index];
        let repeat_string = "";
        let action_string = get_action_string(action, source);

        if (settings["repeat_" + index]) {
            switch (day) {
                case ONCE:
                case DAILY:
                    break;
                case MON_FRI:
                    repeat_string = " (every week)";
                    break;
                default:
                    repeat_string = "s";    // Append 's' to day
                    break;
            }
        } else if (day == MON_FRI || day == DAILY) {
            repeat_string = " (this week)";
        }

        title = "" + (index + 1) + ") " + zone.name + ": " + action_string + day_string[day] + repeat_string;

        if (action == ACTION_TRANSFER && transfer_zone) {
            title += " to " + transfer_zone.name;
        }

        if (valid_time.relative) {
            title += " in " + (valid_time.hours ? valid_time.hours + "h and " : "");
            title += valid_time.minutes + "min";
        } else {
            title += " @ " + valid_time.friendly;
        }
    } else if (index < settings.alarm_count - 1) {
        title = "" + (index + 1) + ") " + "Inactive Alarm";
    } else {
        title = "New Alarm";
    }

    return title;
}

function get_action_string(action, source) {
    let action_string = "";

    switch (action) {
        case ACTION_STANDBY:
            action_string = "Standby";
            break;
        case ACTION_STOP:
            action_string = "Stop";
            break;
        case ACTION_PLAY:
            if (source) {
                if (source.length > 12) {
                    source = source.slice(0, 9) + '...'
                }

                action_string = 'Play "' + source + '"';
            } else {
                action_string = 'Play ' + source_strings[SRC_QUEUE];
            }
            break;
        case ACTION_TRANSFER:
            action_string = "Transfer";
            break;
    }

    return action_string;
}

function add_pending_alarm(entry) {
    let i;

    for (i = 0; i < pending_alarms.length; i++) {
        if (pending_alarms[i].timeout > entry.timeout) {
            break;
        }
    }

    pending_alarms.splice(i, 0, entry);
}

function get_pending_alarms_string() {
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const max_listed = 5;
    let alarm_string = "";

    for (let i = 0; i < pending_alarms.length && i < max_listed; i++) {
        const date_time = new Date(pending_alarms[i].timeout);
        let time = date_time.toLocaleTimeString();

        if (isNaN(time[time.length - 1]) == false) {
            time = time.slice(0, -3);
        } else if (time[time.length - 1] == 'M') {
            time = time.slice(0, -6) + time.slice(-3);
        }

        alarm_string += "\n" + pending_alarms[i].action + " on " + day[date_time.getDay()];
        alarm_string += " @ " + time;
    }

    if (alarm_string.length) {
        if (pending_alarms.length > max_listed) {
            // Truncate to limit number of lines in status string
            alarm_string = "Pending Alarms (first " + max_listed + "):" + alarm_string;
        } else {
            alarm_string = "Pending Alarms:" + alarm_string;
        }
    } else {
        alarm_string = "No active Alarms";
    }

    return alarm_string;
}

function get_current_volume_by_output_id(output_id) {
    return get_current_volume(transport.zone_by_output_id(output_id), output_id);
}

function get_current_volume(zone, output_id) {
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

function set_timer(reset) {
    const now = Date.now();
    let settings = wake_settings;

    if (reset) {
        pending_alarms = [];
    } else {
        // Remove expired alarms
        for (let i = pending_alarms.length - 1; i >= 0; i--) {
            if (pending_alarms[i].timeout <= now) {
                pending_alarms.splice(0, i + 1);
                break;
            }
        }
    }

    for (let i = 0; i < settings.alarm_count; i++) {
        if (reset || timeout_id[i] == null) {
            if (settings["timer_active_" + i] && settings["zone_" + i]) {
                const action = settings["wake_action_" + i];
                const wake_day = settings["wake_day_" + i];
                const fade_time = (settings["transition_type_" + i] == TRANS_FADING ?
                                   +settings["transition_time_" + i] : 0);
                let date = new Date(now);

                // Configuration is already validated at this point, get processed fields
                const valid_time = timer.validate_time_string(settings["wake_time_" + i], wake_day == ONCE);

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

                    if (days_to_skip == 0 && timeout_time < now) {
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
                const source_type = settings["source_type_" + i];
                const source = (source_type == SRC_QUEUE ? null : settings["source_entry_" + i]);
                let action_string = settings["zone_" + i].name + ": ";
                action_string += get_action_string(action, source);

                add_pending_alarm( { timeout: timeout_time, action: action_string } );

                timeout_time -= now;

                if (timeout_id[i] != null) {
                    // Clear pending timeout
                    clearTimeout(timeout_id[i]);
                }

                timeout_id[i] = setTimeout(timer_timed_out, timeout_time, i);
            } else if (timeout_id[i] != null) {
                // Clear pending timeout
                clearTimeout(timeout_id[i]);
                timeout_id[i] = null;
            }
        }
    }

    // Update status
    svc_status.set_status(get_pending_alarms_string(), false);
}

function timer_timed_out(index) {
    let settings = wake_settings;

    timeout_id[index] = null;

    log(`Alarm ${index + 1} expired`);

    const output = settings["zone_" + index];
    const zone = transport && transport.zone_by_output_id(output.output_id);

    if (!zone) return;

    const action       = settings["wake_action_" + index];
    const source_type  = settings["source_type_" + index];
    const source_entry = settings["source_entry_" + index];
    const trans_time   = (settings["transition_type_" + index] == TRANS_TRACKBOUND ?
                         +settings["transition_time_" + index] * 60 : 0);
    const now_playing  = zone.now_playing;

    if (action == ACTION_PLAY && zone.outputs[0].output_id == output.output_id) {
        // Perform source selection only for the first output within a grouped zone,
        // the selection will then be played for all the outputs within that grouped zone

        // Performing a play action on an output that is part of a grouped zone
        // also starts playback on the other outputs of that grouped zone
        // Grouped zone fading is achieved by the user by setting separate fading alarms
        // for the individual outputs of the grouped zone

        if (source_type != SRC_QUEUE && source_entry) {
            // Activate selected profile for the current session
            // Use multi session feature of browse API via multi_session_key
            // https://community.roonlabs.com/t/roon-extension-http-apis/24939/104
            select_profile(settings, { multi_session_key: index.toString() }, () => {
                // Activate selected source
                const opts = {
                    multi_session_key: index.toString(),
                    pop_all: true
                };
                const path = [source_strings[source_type], source_entry]
                             .concat(activation_strings[source_type]);

                log(path);

                refresh_browse(opts, path, (item, done) => {
                    const opts = {
                        hierarchy:         "browse",
                        zone_or_output_id: output.output_id,
                        item_key:          item.item_key,
                        multi_session_key: index.toString()
                    };

                    refresh_browse(opts, [], (item, done) => {
                        if (done) {
                            control(settings, zone, index);
                        }
                    });
                });
            });
        } else if (!zone.is_play_allowed && zone.is_previous_allowed) {
            // Start off with previous track
            transport.control(zone, 'previous', (error) => {
                if (!error) {
                    // Turn radio function on to keep the music going
                    transport.change_settings(zone, { auto_radio: true });
                    control(settings, zone, index);
                }
            });
        } else {
            control(settings, zone, index);
        }
    } else if ((action == ACTION_STOP || action == ACTION_STANDBY) &&
                zone.state == 'playing' && trans_time > 0 && now_playing) {
        // Make transition at track boundary
        const length = now_playing.length;
        const properties = {
            now_playing:     { seek_position: 0 },
            state:           'stopped',
            is_play_allowed: true
        };

        if (length && (length - now_playing.seek_position < trans_time)) {
            on_zone_property_changed(zone.zone_id, properties, (zone) => {
                control(settings, zone, index);
            });
        }
    } else {
        control(settings, zone, index);
    }

    const date = new Date();
    const day = date.getDay();
    const wake_day = settings["wake_day_" + index];

    if (settings["repeat_" + index] == false &&
        ((wake_day <= ONCE) ||
         (wake_day == WEEKEND && day == SUN) ||
         (wake_day == MON_FRI && day == FRI) ||
         (wake_day == DAILY && day == SAT))) {
        // Disable this timer
        settings["timer_active_" + index] = false;
        roon.save_config("settings", settings);
    }

    set_timer(false);
}

function control(settings, zone, index) {
    const fade_time = (settings["transition_type_" + index] == TRANS_FADING ?
                       +settings["transition_time_" + index] : 0);
    const output = settings["zone_" + index];
    const current_volume = get_current_volume(zone, output.output_id);
    let end_volume = settings["wake_volume_" + index];
    let action = settings["wake_action_" + index];

    if (fade_time > 0 && current_volume && action != ACTION_TRANSFER) {
        // Take care of fading
        let start_volume;

        if (zone.state == 'playing') {
            start_volume = current_volume.value;
        } else {
            start_volume = current_volume.min;
        }

        if (action == ACTION_STANDBY || action == ACTION_STOP) {
            end_volume = current_volume.min;
        }

        if (end_volume != start_volume) {
            const ms_per_step = (fade_time * 60 * 1000) / Math.abs(end_volume - start_volume);

            if (interval_id[index] != null) {
                clearInterval(interval_id[index]);
            }

            interval_id[index] = setInterval(take_fade_step, ms_per_step, index, start_volume, end_volume);

            log("Fading activated");

            if (zone.state == 'playing' && (action == ACTION_STANDBY || action == ACTION_STOP)) {
                // Remain playing during fade out
                action = ACTION_NONE;
            }

            end_volume = start_volume;
            fade_volume[index] = start_volume;
        }
    }

    switch (action) {
        case ACTION_PLAY:
            if (current_volume) {
                // Set wake volume, even if already playing
                transport.change_volume(output, "absolute", end_volume);
            }

            if (zone.state != 'playing') {
                transport.control(output, 'play');
            }
            break;
        case ACTION_STOP:
            if (zone.state == 'playing') {
                transport.control(output, zone.is_pause_allowed ? 'pause' : 'stop');
            } else {
                log("Playback already stopped");
            }
            break;
        case ACTION_STANDBY:
            transport.standby(output, {}, function(error) {
                if (error) {
                    log("Output doesn't support standby");

                    if (zone.state == 'playing') {
                        transport.control(output, zone.is_pause_allowed ? 'pause' : 'stop');
                    }
                }
            });
            break;
        case ACTION_TRANSFER:
            const transfer_zone = settings["transfer_zone_" + index];

            if (current_volume) {
                // Set volume for the zone we transfer to
                transport.change_volume(transfer_zone, "absolute", end_volume);
            }
            transport.transfer_zone(output, transfer_zone);
            break;
        case ACTION_NONE:
        default:
            break;
    }
}

function take_fade_step(index, start_volume, end_volume) {
    let output = wake_settings["zone_" + index];
    let step = (start_volume < end_volume ? 1 : -1);
    let zone = transport.zone_by_output_id(output.output_id);
    const current_volume = get_current_volume(zone, output.output_id);

    // Detect volume control collisions, allow for 1 step volume set back
    if (current_volume && current_volume.value - fade_volume[index] > 1) {
        // Somebody else is turning the knob as well, hands off
        clearInterval(interval_id[index]);
        interval_id[index] = null;
        log("Fading terminated for alarm " + (index + 1));
    } else if (zone.state != 'playing') {
        // Postpone fading in case data is still loading
        if (zone.state != 'loading') {
            // Playback is stopped manually
            clearInterval(interval_id[index]);
            interval_id[index] = null;

            // Restore start volume
            transport.change_volume(output, "absolute", start_volume);
        }
    } else if (fade_volume[index] != end_volume) {
        // Fade one step
        fade_volume[index] += step;
        transport.change_volume(output, "absolute", fade_volume[index]);
    } else {
        // Level reached, clear interval
        clearInterval(interval_id[index]);
        interval_id[index] = null;

        const action = wake_settings["wake_action_" + index];

        if (action == ACTION_STOP || action == ACTION_STANDBY) {
            // Stop playback
            transport.control(output, zone.is_pause_allowed ? 'pause' : 'stop');

            on_zone_property_changed(zone.zone_id, { is_play_allowed: true }, function(zone) {
                // Restore start volume
                transport.change_volume(output, "absolute", start_volume, function(error) {
                    if (!error && action == ACTION_STANDBY) {
                        // Switch to standby
                        transport.standby(output, {}, function(error) {
                            if (error) {
                                log("Output doesn't support standby");
                            }
                        });
                    }
                });
            });
        }
    }
}

function query_dropdowns(settings, cb) {
    query_profiles(settings, () => {
        query_entries(settings, () => {
            cb && cb();
        });
    });
}

function query_profiles(settings, cb) {
    let valid = false;

    profiles = [];      // Start off with an empty list

    refresh_browse({ pop_all: true }, [ 'Settings', 'Profile', '' ], (item, done) => {
        profiles.push({ title: item.title, value: item.title });

        if (item.subtitle == "selected") {
            active_profile = item.title;
        }

        if (item.title == settings.profile) {
            valid = true;
        }

        if (done) {
            if (!valid) {
                // Configured profile is no longer available
                settings.profile = undefined;
            }

            cb && cb();
        }
    });
}

function query_entries(settings, cb) {
    const source = settings["source_type_" + settings.selected_timer];
    const force = (settings.profile != queried_profile);

    if (source && (force || source !== queried_source_type)) {
        const path = [source_strings[source], ''];
        let values = [];

        queried_profile = settings.profile;
        queried_source_type = source;

        refresh_browse({ pop_all: true }, path, (item, done) => {
            if (item) {
                values.push({ title: item.title, value: item.title });
            }

            if (done) {
                source_entry_list = values;
                cb && cb();
            }
        });
    } else if (cb) {
        cb();
    }
}

function select_profile(settings, opts, cb) {
    opts = Object.assign({ pop_all: true }, opts);

    if (settings.profile) {
        refresh_browse(opts, [ 'Settings', 'Profile', settings.profile ], (item) => {
            const source_opts = {
                hierarchy: "browse",
                item_key:  item.item_key,
                multi_session_key: opts.multi_session_key
            };

            refresh_browse(source_opts, [], (item, done) => {
                if (done) {
                    active_profile = settings.profile;
                    log("Selected profile: " + settings.profile);

                    cb && cb();
                }
            });
        });
    } else if (cb) {
        cb();
    }
}

function refresh_browse(opts, path, cb) {
    opts = Object.assign({ hierarchy: "browse" }, opts);

    core.services.RoonApiBrowse.browse(opts, (err, r) => {
        if (err == false) {
            if (r.action == "list") {
                let list_offset = (r.list.display_offset > 0 ? r.list.display_offset : 0);

                load_browse(opts.multi_session_key, list_offset, path, cb);
            }
        }
    });
}

function load_browse(multi_session_key, list_offset, path, cb) {
    const opts = {
        hierarchy:          "browse",
        offset:             list_offset,
        set_display_offset: list_offset,
        multi_session_key
    };

    core.services.RoonApiBrowse.load(opts, (err, r) => {
        if (err == false && path) {
            if (!r.list.level || !path[r.list.level - 1] || r.list.title == path[r.list.level - 1]) {
                if (r.items.length) {
                    for (let i = 0; i < r.items.length; i++) {
                        let match = (r.items[i].title == path[r.list.level]);

                        if (!path[r.list.level] || match) {
                            if (r.list.level < path.length - 1) {
                                const opts = {
                                    item_key: r.items[i].item_key,
                                    multi_session_key
                                };

                                refresh_browse(opts, path, cb);
                                break;
                            } else if (cb) {
                                cb(r.items[i], match || i + 1 == r.items.length);
                            }
                        }
                    }
                } else if (cb) {
                    cb(undefined, true);
                }
            }
        }
    });
}

function log(message, is_error) {
    const date = new Date();

    if (is_error) {
        console.error(date.toISOString(), '- Err:', message);
    } else {
        console.log(date.toISOString(), '- Inf:', message);
    }
}

function init() {
    for (let i = 0; i < wake_settings.alarm_count; i++) {
        timeout_id.push(null);
        interval_id.push(null);
        fade_volume.push(null);
    }

    if (validate_config(wake_settings)) {
        roon.save_config("settings", wake_settings);
    }
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        query_dropdowns(wake_settings, () => {
            cb(makelayout(wake_settings));
        });
    },
    save_settings: function(req, isdryrun, settings) {
        select_profile(settings.values, { multi_session_key: '0' }, () => {
            query_entries(settings.values, () => {
                let l = makelayout(settings.values);
                req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

                if (!isdryrun && !l.has_error) {
                    wake_settings = l.values;
                    if (!wake_settings.profile) {
                        wake_settings.profile = active_profile;
                    }
                    svc_settings.update_settings(l);
                    roon.save_config("settings", wake_settings);

                    set_timer(true);
                }
            });
        });
    }
});

var svc_status = new RoonApiStatus(roon);

roon.init_services({
    required_services:   [ RoonApiTransport, RoonApiBrowse ],
    provided_services:   [ svc_settings, svc_status ]
});

init();
roon.start_discovery();
