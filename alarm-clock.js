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
const DEFAULT_SESSION = 0;

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
var active_profiles = {};

var timer = new ApiTimeInput();

var roon = new RoonApi({
    extension_id:        'com.theappgineer.alarm-clock',
    display_name:        'Alarm Clock',
    display_version:     '0.8.2',
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

                select_profile(wake_settings);
                set_timers(true);
            } else if (response == "Changed") {
                if (msg.zones_changed) {
                    zones = msg.zones_changed;
                }
                if (msg.zones_added) {
                    zones = msg.zones_added;
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
            title: get_alarm_title(settings, i).combined,
            value: i
        });

        if (settings['zone_' + i]) {
            used_alarms++;
        }
    }

    if (used_alarms == settings.alarm_count && used_alarms < MAX_ALARM_COUNT) {
        set_defaults(settings, settings.alarm_count++);

        selector.values.push({
            title: get_alarm_title(settings, used_alarms).combined,
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
    const title = get_alarm_title(settings, i);

    let alarm = {
        type:        "group",
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
        let time = {
            type:        "group",
            title:       "Time",
            collapsable: true,
            items:       [{
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
            }]
        };

        let v = {
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

        let place = {
            type:        "group",
            title:       "Zone",
            collapsable: true,
            items:       [{
                type:    'zone',
                title:   'Output',
                setting: 'zone_' + i
            }]
        };

        let event = {
            type:        "group",
            title:       "Event",
            collapsable: true,
            items:       [{
                type:    "dropdown",
                title:   "Action",
                values:  [
                    { title: "Play",     value: ACTION_PLAY     },
                    { title: "Stop",     value: ACTION_STOP     },
                    { title: "Standby",  value: ACTION_STANDBY  },
                    { title: "Transfer", value: ACTION_TRANSFER }
                ],
                setting: "wake_action_" + i
            }]
        };

        const action = settings["wake_action_" + i];

        // Source selection
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

        // Volume control
        const set_output = (action == ACTION_TRANSFER ? settings["transfer_zone_" + i]
                                                      : settings["zone_" + i]);
        const zone = set_output && transport.zone_by_output_id(set_output.output_id);

        if (zone && zone.outputs) {
            let items = [];

            if (zone.outputs.length === 1) {
                clear_secondary_outputs(settings, i);
            } else {
                place.items[0].title = 'Primary Output';
            }

            zone.outputs.forEach((output) => {
                let alarm_index;

                if (output.output_id == set_output.output_id) {
                    alarm_index = i;
                } else {
                    alarm_index = setup_secondary_output(settings, i, output.output_id);
                }

                if (output.volume && action == ACTION_PLAY || action == ACTION_TRANSFER) {
                    const volume = output.volume;
                    let entry = {
                        type:    'integer',
                        min:     volume.min,
                        max:     volume.max,
                        title:   output.display_name + (volume.type == 'db' ? ' (dB)' : ''),
                        setting: 'wake_volume_' + alarm_index
                    };

                    if (output.output_id == set_output.output_id) {
                        // Put selected output at the top
                        items.unshift(entry);
                    } else {
                        items.push(entry);
                    }

                    const set_volume = settings[entry.setting];
                    if (!set_volume) {
                        // Set volume to the current value of the output
                        settings[entry.setting] = volume.value;
                    } else if (set_volume < volume.min || set_volume > volume.max) {
                        entry.error = `Volume must be between ${volume.min} and ${volume.max}`;
                        l.has_error = true;
                    }
                }
            });

            if (items.length === 1) {
                const volume_type = get_current_volume(zone, set_output.output_id).type;

                items[0].title = 'Volume ' + (volume_type == 'db' ? ' (dB)' : '');

                event.items.push(items[0]);
            } else if (items.length > 1) {
                event.items.push({
                    type:        'group',
                    title:       'Output Volumes',
                    collapsable: true,
                    items
                });
            }
        }

        // Transitioning
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
            event.items.push({
                type:    "zone",
                title:   "Transfer Zone",
                setting: "transfer_zone_" + i
            });

            settings["transition_type_" + i] = TRANS_INSTANT;
        } else {
            if (set_output && get_current_volume(zone, set_output.output_id)) {
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

        if (title.time)   time.title  += `: ${title.date} ${title.time}`;
        if (title.place)  place.title += `: ${title.place}`;
        if (title.action) event.title += `: ${title.action}`;

        alarm.items.push(place);
        alarm.items.push(event);
        alarm.items.push(time);
    }

    alarm.title = title.combined;

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
    const output = settings["zone_" + index];
    const day = settings["wake_day_" + index];
    const valid_time = timer.validate_time_string(settings["wake_time_" + index], day == ONCE);
    let title = {};

    if (active && output && valid_time) {
        const day_string = [
            "on Sunday",     // SUN
            "on Monday",     // MON
            "on Tueday",     // TUE
            "on Wednesday",  // WED
            "on Thursday",   // THU
            "on Friday",     // FRI
            "on Saturday",   // SAT
            "",              // ONCE
            "daily",         // DAILY
            "on weekdays",   // MON_FRI
            "on the weekend" // WEEKEND
        ];
        const action = settings["wake_action_" + index];
        const source_type = settings["source_type_" + index];
        const source_entry = settings["source_entry_" + index];
        const source = (source_type == SRC_QUEUE ? null : source_entry);
        const transfer_zone = settings["transfer_zone_" + index];
        let repeat_string = "";

        title.place = transport.zone_by_output_id(output.output_id).display_name;
        title.action = get_action_string(action, source, transfer_zone);

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

        title.date = day_string[day] + repeat_string;

        if (valid_time.relative) {
            title.time = "in " + (valid_time.hours ? valid_time.hours + "h and " : "");
            title.time += valid_time.minutes + "min";
        } else {
            title.time = "@ " + valid_time.friendly;
        }

        title.combined = `${index + 1}) ${title.place}: ${title.action} ${title.date} ${title.time}`;
    } else if (index < settings.alarm_count - 1) {
        title.combined = `${index + 1}) Inactive Alarm`;
    } else {
        title.combined = "New Alarm";
    }

    return title;
}

function get_action_string(action, source, transfer_zone) {
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

            if (transfer_zone) {
                action_string += " to " + transfer_zone.name;
            }
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

function setup_secondary_output(settings, parent_index, output_id) {
    // Grouped zone volume control and fading is achieved by having dedicated settings
    // for the individual outputs of the grouped zone
    const secondary_count = (settings.secondary_count ? settings.secondary_count : MAX_ALARM_COUNT);
    const key = (settings['wake_action_' + parent_index] == ACTION_TRANSFER ? 'transfer_zone_' : 'zone_');
    let   secondary_index = MAX_ALARM_COUNT;

    // Search for available index
    for (let i = MAX_ALARM_COUNT; i < secondary_count; i++) {
        const current_parent_index = settings['parent_of_' + i];
        const current_output_id    = settings[key + i] && settings[key + i].output_id;

        if (current_parent_index === undefined ||
            (current_parent_index === parent_index && current_output_id == output_id)) {
            secondary_index = i;
            break;
        } else {
            secondary_index++;
        }
    }

    settings.secondary_count = (secondary_index + 1 > secondary_count ? secondary_index + 1 : secondary_count);

    // Store specific settings
    settings['parent_of_' + secondary_index] = parent_index;
    settings[key          + secondary_index] = { output_id };

    return secondary_index;
}

function clear_secondary_outputs(settings, parent_index) {
    const secondary_count = (settings.secondary_count ? settings.secondary_count : MAX_ALARM_COUNT);

    for (let i = MAX_ALARM_COUNT; i < secondary_count; i++) {
        if (settings['parent_of_' + i] === parent_index) {
            delete settings['parent_of_' + i];
        }
    }
}

function get_current_volume(zone, output_id) {
    if (zone && zone.outputs) {
        for(let i = 0; i < zone.outputs.length; i++) {
            if (zone.outputs[i].output_id == output_id) {
                return zone.outputs[i].volume;
            }
        }
    }
}

function set_timers(reset) {
    const now = Date.now();
    const settings = wake_settings;

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
            if (settings["timer_active_" + i] && settings["zone_" + i].output_id) {
                const action = settings["wake_action_" + i];
                const wake_day = settings["wake_day_" + i];
                const fade_time = (settings["transition_type_" + i] == TRANS_FADING ?
                                   +settings["transition_time_" + i] : 0);
                let date = new Date(now);

                // Configuration is already validated at this point, get processed fields
                const valid_time = timer.validate_time_string(settings["wake_time_" + i], wake_day == ONCE);

                date.setSeconds(i * 2);     // Spread expire time of alarms
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

    const zone = transport.zone_by_output_id(settings["zone_" + index].output_id);

    if (!zone) return;

    const action       = settings["wake_action_" + index];
    const trans_time   = (settings["transition_type_" + index] == TRANS_TRACKBOUND ?
                         +settings["transition_time_" + index] * 60 : 0);
    const now_playing  = zone.now_playing;

    if (action == ACTION_PLAY) {
        const source_type  = settings["source_type_" + index];
        const source_entry = settings["source_entry_" + index];

        if (source_type != SRC_QUEUE && source_entry) {
            // Activate selected profile for the current session
            // Use multi session feature of browse API via multi_session_key
            // https://community.roonlabs.com/t/roon-extension-http-apis/24939/104
            select_profile(settings, index, () => {
                // Activate selected source
                const opts = {
                    hierarchy:         source_strings[source_type].toLowerCase().replace(' ', '_'),
                    multi_session_key: index.toString(),
                    pop_all:           true
                };
                const path = [source_entry].concat(activation_strings[source_type]);

                log(path);

                refresh_browse(opts, path, (item, done) => {
                    const opts = {
                        hierarchy:         source_strings[source_type].toLowerCase().replace(' ', '_'),
                        zone_or_output_id: zone.zone_id,
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
               zone.state == 'playing' && trans_time > 0 && now_playing.length &&
               (now_playing.length - now_playing.seek_position < trans_time)) {
        // Make transition at track boundary
        const properties = {
            now_playing:     { seek_position: 0 },
            state:           'stopped',
            is_play_allowed: true
        };

        on_zone_property_changed(zone.zone_id, properties, (zone) => {
            control(settings, zone, index);
        });
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

    set_timers(false);
}

function control(settings, zone, index) {
    const output_id = settings['zone_' + index].output_id;
    const action    = settings["wake_action_" + index];
    const fade_time = (settings["transition_type_" + index] == TRANS_FADING ?
                       +settings["transition_time_" + index] : 0);

    zone.outputs.forEach((output) => {
        if (output.output_id == output_id) {
            // Volume control for primary output
            control_volume(settings, zone, index, action, fade_time);
        } else {
            // Volume control for secondary outputs
            const secondary_index = setup_secondary_output(settings, index, output.output_id);

            control_volume(settings, zone, secondary_index, action, fade_time);
        }
    });

    // Remain playing during fade out
    if (!(fade_time > 0 && zone.state == 'playing' && (action == ACTION_STANDBY || action == ACTION_STOP))) {
        switch (action) {
            case ACTION_PLAY:
                if (zone.state != 'playing') {
                    // Performing a play action on an output that is part of a grouped zone
                    // also starts playback on the other outputs of that grouped zone
                    transport.control(zone, 'play');
                }
                break;
            case ACTION_STOP:
                if (zone.state == 'playing') {
                    transport.control(zone, zone.is_pause_allowed ? 'pause' : 'stop');
                }
                break;
            case ACTION_STANDBY:
                transport.standby(output_id, {}, function(error) {
                    if (error) {
                        log("Output doesn't support standby");

                        if (zone.state == 'playing') {
                            transport.control(zone, zone.is_pause_allowed ? 'pause' : 'stop');
                        }
                    }
                });
                break;
            case ACTION_TRANSFER:
                transport.transfer_zone(zone, settings["transfer_zone_" + index]);
                break;
        }
    }
}

function control_volume(settings, zone, index, action, fade_time) {
    // WARNING: Only a few settings are available for secondary outputs
    //          Parent settings have to be passed via function parameters
    const output_id = (action == ACTION_TRANSFER ? settings["transfer_zone_" + index].output_id
                                                 : settings['zone_' + index].output_id);
    const current_volume = get_current_volume(zone, output_id);

    if (!current_volume) return;

    // Fallback to current volume level if setting is not available
    let end_volume = settings["wake_volume_" + index] ? settings["wake_volume_" + index] : current_volume.value;

    if (fade_time > 0) {
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
            const steps = Math.abs(end_volume - start_volume) / current_volume.step;
            const ms_per_step = (fade_time * 60 * 1000) / steps;

            if (interval_id[index] != null) {
                clearInterval(interval_id[index]);
            }

            interval_id[index] = setInterval(take_fade_step, ms_per_step, index, action, start_volume, end_volume);

            log('Fading activated for output: ' + output_id);

            end_volume = start_volume;
            fade_volume[index] = start_volume;
        }
    }

    if (action == ACTION_PLAY || action == ACTION_TRANSFER) {
        // Set wake volume, even if already playing
        transport.change_volume(output_id, "absolute", end_volume);
    }
}

function take_fade_step(index, action, start_volume, end_volume) {
    const output_id = wake_settings["zone_" + index].output_id;
    const zone = transport.zone_by_output_id(output_id);
    const current_volume = get_current_volume(zone, output_id);
    const step = (start_volume < end_volume ? 1 : -1) * current_volume.step;

    // Detect volume control collisions, allow for 1 step volume set back
    if (current_volume.value - fade_volume[index] > 1) {
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
            transport.change_volume(output_id, "absolute", start_volume);
        }
    } else if (fade_volume[index] != end_volume) {
        // Fade one step
        fade_volume[index] += step;
        transport.change_volume(output_id, "absolute", fade_volume[index]);
    } else {
        // Level reached, clear interval
        clearInterval(interval_id[index]);
        interval_id[index] = null;

        if (action == ACTION_STOP || action == ACTION_STANDBY) {
            // Stop playback
            transport.control(zone, zone.is_pause_allowed ? 'pause' : 'stop', () => {
                // Restore start volume
                transport.change_volume(output_id, "absolute", start_volume, () => {
                    if (action == ACTION_STANDBY) {
                        // Switch to standby
                        transport.standby(output_id, {}, (error) => {
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

    refresh_browse({ pop_all: true }, [ 'Profile', '' ], (item, done) => {
        profiles.push({ title: item.title, value: item.title });

        if (item.subtitle == "selected") {
            active_profiles[DEFAULT_SESSION] = item.title;
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
    const source_type = settings["source_type_" + settings.selected_timer];
    const force = (settings.profile != queried_profile);

    if (source_type && (force || source_type !== queried_source_type)) {
        const opts = {
            hierarchy: source_strings[source_type].toLowerCase().replace(' ', '_'),
            pop_all:   true
        };
        let values = [];

        queried_profile = settings.profile;
        queried_source_type = source_type;

        refresh_browse(opts, [''], (item, done) => {
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

function select_profile(settings, index, cb) {
    if (index === undefined) index = DEFAULT_SESSION;

    if (settings.profile && settings.profile != active_profiles[index]) {
        const opts = {
            pop_all:           true,
            multi_session_key: index.toString()
        };

        refresh_browse(opts, [ 'Profile', settings.profile ], (item) => {
            const source_opts = {
                item_key:          item.item_key,
                multi_session_key: index.toString()
            };

            refresh_browse(source_opts, [], (item, done) => {
                if (done) {
                    active_profiles[index] = settings.profile;
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
    opts = Object.assign({ hierarchy: "settings", multi_session_key: '0' }, opts);

    core.services.RoonApiBrowse.browse(opts, (err, r) => {
        if (err == false) {
            if (r.action == "list") {
                let list_offset = (r.list.display_offset > 0 ? r.list.display_offset : 0);

                load_browse(opts, list_offset, path, cb);
            }
        }
    });
}

function load_browse(input_opts, list_offset, path, cb) {
    const opts = {
        hierarchy:          input_opts.hierarchy,
        offset:             list_offset,
        set_display_offset: list_offset,
        multi_session_key:  input_opts.multi_session_key
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
                                    hierarchy:         input_opts.hierarchy,
                                    item_key:          r.items[i].item_key,
                                    multi_session_key: input_opts.multi_session_key
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
        select_profile(settings.values, DEFAULT_SESSION, () => {
            query_entries(settings.values, () => {
                let l = makelayout(settings.values);
                req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

                if (!isdryrun && !l.has_error) {
                    wake_settings = l.values;
                    if (!wake_settings.profile) {
                        wake_settings.profile = active_profiles[DEFAULT_SESSION];
                    }
                    svc_settings.update_settings(l);
                    roon.save_config("settings", wake_settings);

                    set_timers(true);
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
