'use strict';

/*
 * SiPass integrated Management Station API: event texts and helpers. Names and numbers from the API's own description
 * (swagger of SiPass 3.0, definitions AlarmMessage / State: ObjectState, Type).
 */

const OBJECT_STATES = ('NoState,Unknown,CommunicatonLost,CommunicationBack,DailyCode,LowBattery,GoodAccess,Duress,SoftAntipassbackMode,' +
    'HardAntipassbackMode,CardAtDisabled,GroupError,VoidCard,InvalidFacility,CardLimit,InvalidPIN,BadDailyCode,AccessToAntipassbackArea,' +
    'IndenpendentService,ElevatorAlarm,CardAntipassbackAreaOn,CardAntipassbackAreaOff,CardActFloor,CardNotActFloor,DoorTimeScheduleActive,' +
    'DoorFree,DoorSecured,TamperActive,TamperInactive,ReaderOffline,ReaderOnline,CheckSumError,ReaderTimeout,BadgeCollision,AccessGranted,' +
    'AccessNotGranted,DoorLocked,DoorUnlocked,ReEntryError,HardAntipassbackError,SoftAntipassbackError,NotYetActive,CardExpired,' +
    'TimeScheduleViolation,AccessDenied,InputPassback,PointNormal,PointTamper,DoorClosed,DoorHeld,DoorForced,FireOverrideOff,FireOverrideOn,' +
    'BatteryOK,BatteryFailed,BatteryLow,ACPowerBack,ACPowerFailed,InputTamper,InputClosed,InputOpen,CardLimitReached,PassbackTamper,' +
    'InputDisabled,InputEnabled,InputFaulty,PhysicallyDisabled,PhysicallyEnabled,FaultCleared,Locked,Unlocked,UnitCommunicationLost,' +
    'UnitCommunicationBack,UnitReset,UnitTamperActive,UnitTamperInactive,MemoryFull,PowerLost,PowerBack,MemoryWarning,MemoryOverflow,' +
    'BusAlive,BusDown,IntrusionAreaArmed,IntrusionAreaDisarmed,IntrusionAreaAlarm,IntrusionAreaNormal,IntrusionAreaArmingFailed,' +
    'IntrusionAreaArmingActionComplete,IntrusionAreaPartArmed,IntrusionAreaPartBArmed,AntipassbackAreaCapacityFull,' +
    'AntipassbackAreaCapacityExceeded,AntipassbackAreaCapacityNotFull,AntipassbackAreaCapacityEmpty,AntipassbackAreaCapacityNotEmpty,' +
    'AntipassbackAreaFourEyesAccessAlarm,AntipassbackAreaFourEyesAccessNormal,AntipassbackAreaWorkGroupCapacityFull,' +
    'AntipassbackAreaWorkGroupCapacityExceeded,AntipassbackAreaWorkGroupCapacityNotFull,AntipassbackAreaWorkGroupCapacityEmpty,' +
    'AntipassbackAreaWorkGroupCapacityNotEmpty,AntipassbackAreaCountReset,AntipassbackAreaModeChanged,FlagStateTrue,FlagStateFalse,' +
    'PointAlarm,ReaderDisabled,ReaderEnabled,SelfAuthorize,OutputDisabled,OutputEnabled,UnitNoPrimaryDB,UnitIncmpPrimaryDB,FloorSecured,' +
    'FloorUnsecured,InputUnsealed,InputSealed,InputIsolated,PassbackDenied,OutputSlowPulse,OutputFastPulse,CapacityFullDenied,NoPinEntered,' +
    'AccessibilityCardPresented,ProgrammableAuthAccessDenied,WorkgroupCapacityFullDenied,NoEntry,ExternalSystemOnline,ExternalSystemOffline,' +
    'DoorValidCode,DoorOpened,DoorInEmergencyState,DoorOpeningNotAllowed,DoorInvalidPin,DoorTamper,DoorOnline,DoorOffline,' +
    'DoorAntipassbackError,DoorCardNotActivated,DoorCardExpired,DoorTimeScheduleVioloation,DoorLeftOpened,DoorBatteryLow,' +
    'DeviceOnlineLegacyComms,DeviceOnlineStandardComms').split(',');

// message type (AlarmMessage.Type): note Generic = 4
const TYPES = { 0: 'ConfigurationChange', 1: 'Access', 2: 'StateChange', 3: 'Alarm', 4: 'Generic', 5: 'Service', 6: 'SubscriptionEvent', 7: 'StateRequest' };

// AlarmMessage.SubType (swagger)
const SUBTYPES = ('InputPoint,OutputPoint,AccessPoint,FloorPoint,Creation,Modification,Deletion,BusStatus,UnitStatus,DeviceStatus,' +
    'InputPointStatus,OutputPointStatus,AccessPointStatus,AntipassbackAreaPointStatus,IntrusionAreaStatus,FlagStatus,FloorPointStatus,Generic,' +
    'ACCBus,DialupBus,CerPassBus,ACCFLN,NTFLN,CerPassFLN,EntroFLN,GrantaFLN,IntrusionArea,SintonyIntrusionArea,SPCIntrusionArea,' +
    'AntipassbackAreaCounterValue,AntipassbackAreaModeValue,FlagGeneric,CounterGeneric,TimerGeneric,Others,Alive,' +
    'SipassServiceCommunicationLost,SipassServiceCommunicationRestored').split(',');

// SiPass 3.0 sends access events without ObjectState, the result is only in the text ("Gültiger Ausweis: <card> Firmencode 0")
// -> denied words first ("Ungültiger Ausweis" contains "gültiger Ausweis")
const DENIED_TEXT = /ungültig|ungueltig|verweigert|abgewiesen|gesperrt|abgelaufen|nicht (berechtigt|gültig|aktiv|erlaubt)|kein zutritt|zeitplan|zeitprofil|falsche pin|antipassback|invalid|denied|expired|void|not valid|rejected|not granted|violation/i;
const GRANTED_TEXT = /gültig|gueltig|zutritt gewährt|valid card|access granted|good access/i;

const GRANTED = new Set(['AccessGranted', 'GoodAccess', 'DoorValidCode']);
const DENIED = new Set(['AccessNotGranted', 'AccessDenied', 'VoidCard', 'InvalidFacility', 'InvalidPIN', 'BadDailyCode', 'CardAtDisabled',
    'GroupError', 'CardLimit', 'CardLimitReached', 'NotYetActive', 'CardExpired', 'TimeScheduleViolation', 'ReEntryError', 'HardAntipassbackError',
    'SoftAntipassbackError', 'PassbackDenied', 'CapacityFullDenied', 'NoPinEntered', 'ProgrammableAuthAccessDenied', 'WorkgroupCapacityFullDenied',
    'NoEntry', 'DoorOpeningNotAllowed', 'DoorInvalidPin', 'DoorAntipassbackError', 'DoorCardNotActivated', 'DoorCardExpired',
    'DoorTimeScheduleVioloation']);

// German texts for the common ones (others keep the SiPass name)
const TEXT = {
    AccessGranted: 'Zutritt gewährt', GoodAccess: 'Zutritt gewährt', DoorValidCode: 'Gültiger Code', AccessNotGranted: 'Zutritt verweigert',
    AccessDenied: 'Zutritt verweigert', InvalidPIN: 'Falsche PIN', VoidCard: 'Ungültige Karte', CardExpired: 'Karte abgelaufen',
    NotYetActive: 'Karte noch nicht gültig', TimeScheduleViolation: 'Außerhalb des Zeitplans', DoorForced: 'Tür aufgebrochen',
    DoorHeld: 'Tür zu lange offen', DoorClosed: 'Tür zu', DoorOpened: 'Tür offen', DoorLocked: 'Tür versperrt', DoorUnlocked: 'Tür entriegelt',
    TamperActive: 'Sabotage', TamperInactive: 'Sabotage beendet', ReaderOffline: 'Leser offline', ReaderOnline: 'Leser online',
    IntrusionAreaArmed: 'Bereich scharf', IntrusionAreaDisarmed: 'Bereich unscharf', IntrusionAreaAlarm: 'Bereich Alarm',
    IntrusionAreaPartArmed: 'Bereich teilscharf', CommunicatonLost: 'Verbindung verloren', CommunicationBack: 'Verbindung wieder da',
    Duress: 'Bedrohung', DoorLeftOpened: 'Tür offen gelassen',
};

/** ObjectState as name: from a number, "34", "AccessGranted" or "AccessGranted = 34" */
function stateName(v) {
    if (v === undefined || v === null || v === '') {
        return '';
    }
    if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
        return OBJECT_STATES[Number(v)] || String(v);
    }
    return String(v).split('=')[0].trim();
}

function enumName(v, table) {
    if (v === undefined || v === null || v === '') {
        return '';
    }
    if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
        return table[Number(v)] || String(v);
    }
    return String(v).split('=')[0].trim();
}

function typeName(v) {
    return enumName(v, TYPES);
}

/** card numbers (long digit runs) shortened to their last 4 digits - they do not belong into states and logs */
function maskCards(text) {
    return String(text || '').replace(/\d{8,}/g, d => `…${d.slice(-4)}`);
}

/** field of an object regardless of its case (PascalCase from .NET, camelCase from some serializers) */
function field(o, name) {
    if (!o || typeof o !== 'object') {
        return undefined;
    }
    if (name in o) {
        return o[name];
    }
    const low = name.toLowerCase();
    const k = Object.keys(o).find(x => x.toLowerCase() === low);
    return k === undefined ? undefined : o[k];
}

/** everything that looks like a message in the arguments of a hub call (objects, JSON strings, arrays) */
function messages(args) {
    const out = [];
    const walk = (a, depth) => {
        if (depth > 4 || a === null || a === undefined) {
            return;
        }
        if (typeof a === 'string') {
            const s = a.trim();
            if (s.startsWith('{') || s.startsWith('[')) {
                try {
                    walk(JSON.parse(s), depth + 1);
                } catch {
                    // plain text
                }
            }
            return;
        }
        if (Array.isArray(a)) {
            for (const x of a) {
                walk(x, depth + 1);
            }
            return;
        }
        if (typeof a === 'object') {
            if (['ObjectState', 'Type', 'Description', 'Location'].some(k => field(a, k) !== undefined)) {
                out.push(a);
            } else {
                for (const v of Object.values(a)) {
                    walk(v, depth + 1);
                }
            }
        }
    };
    walk(args, 0);
    return out;
}

/** a message from SiPass in a fixed shape */
function normalize(m) {
    const state = stateName(field(m, 'ObjectState'));
    const time = field(m, 'OccurenceTime') || field(m, 'LogTime') || field(m, 'TimeStamp') || '';
    const ts = time ? Date.parse(time) : NaN;
    const type = typeName(field(m, 'Type'));
    const subType = enumName(field(m, 'SubType'), SUBTYPES);
    const description = maskCards(field(m, 'Description') || '').trim();
    let granted = GRANTED.has(state);
    let denied = DENIED.has(state);
    // no ObjectState (SiPass 3.0 access events): result from the text
    if (!state && type === 'Access' && description) {
        denied = DENIED_TEXT.test(description);
        granted = !denied && GRANTED_TEXT.test(description);
    }
    const person = [field(m, 'FirstName'), field(m, 'LastName')].map(x => String(x || '').trim()).filter(Boolean).join(' ');
    const objectToken = field(m, 'ObjectToken');
    const ev = {
        type,
        subType,
        state,
        text: TEXT[state] || (granted ? 'Zutritt gewährt' : denied ? 'Zutritt verweigert' : state || description.split(':')[0] || subType || type),
        granted,
        denied,
        person,
        description,
        location: String(field(m, 'Location') || ''),
        // the reader is the object (ObjectToken); Token is the message's own number
        token: String(objectToken !== undefined && objectToken !== null && objectToken !== '' ? objectToken : field(m, 'Token') ?? ''),
        time: Number.isFinite(ts) ? ts : Date.now(),
        priority: field(m, 'Priority'),
        alarmState: typeName(field(m, 'State')),
        // keep-alive of the SiPass service (Type Service, SubType Alive) - nothing to show
        alive: subType === 'Alive',
    };
    return ev;
}

/** rule matches a granted access: reader text in the reader's name / location, person text in the description */
function ruleMatches(rule, ev, readerName = '') {
    if (!rule || rule.enabled === false || !ev.granted) {
        return false;
    }
    const low = s => String(s || '').toLowerCase();
    const reader = low(rule.reader).trim();
    if (reader && !(low(readerName).includes(reader) || low(ev.location).includes(reader) || low(ev.description).includes(reader) || low(ev.token) === reader)) {
        return false;
    }
    const person = low(rule.person).trim();
    if (person && !low(ev.person).includes(person) && !low(ev.description).includes(person)) {
        return false;
    }
    return true;
}

module.exports = { OBJECT_STATES, TYPES, SUBTYPES, GRANTED, DENIED, TEXT, stateName, typeName, field, messages, normalize, ruleMatches, maskCards };
