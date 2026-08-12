//! the typed unions everything ipc-facing speaks: one fatal error enum every
//! command returns (spec, error handling) and the non-fatal warnings that
//! ride inside LoadedScene. the frontend maps error kinds to toasts plus
//! recovery flows and warning kinds to banners

use engine::EngineError;
use serde::Serialize;

/// spec's seven fatal kinds plus two documented extensions: BeatmapMismatch
/// (the explicit-override flow needs a catchable typed signal carrying both
/// hashes; with allow_mismatch the same situation downgrades to the
/// BeatmapMismatch warning) and Internal (keeps From<EngineError> total --
/// encode-side and precondition failures cannot legitimately surface from a
/// load, and calling them a parse failure would misreport)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum IpcError {
    ReplayParse {
        message: String,
    },
    BeatmapParse {
        message: String,
    },
    BeatmapNotFound {
        md5: String,
    },
    BeatmapMismatch {
        expected_md5: String,
        actual_md5: String,
    },
    OsuDbNotFound {
        searched: Vec<String>,
    },
    UnsupportedMode {
        mode: String,
    },
    ResourceLimit {
        cap: String,
        limit: u64,
        actual: u64,
    },
    Io {
        message: String,
    },
    Internal {
        message: String,
    },
    InvalidEdit {
        message: String,
    },
    StaleSession,
    NotEditable {
        reason: String,
    },
    /// export destination collision without overwrite consent -- also the
    /// typed answer when a destination appears mid-write (the no-replace
    /// rename closes the check-then-write race)
    FileExists {
        path: String,
    },
    /// a derived value exceeded its on-disk header width during export
    /// narrowing; `field` is the wire spelling the dialog shows
    ExportOverflow {
        field: String,
    },
}

impl From<EngineError> for IpcError {
    fn from(e: EngineError) -> IpcError {
        match e {
            EngineError::BeatmapParse(message) => IpcError::BeatmapParse { message },
            EngineError::ReplayParse(message) => IpcError::ReplayParse { message },
            EngineError::ResourceLimit { cap, limit, actual } => IpcError::ResourceLimit {
                cap: cap.to_string(),
                limit,
                actual,
            },
            EngineError::UnsupportedMode(mode) => IpcError::UnsupportedMode {
                mode: format!("{mode:?}"),
            },
            EngineError::Io(e) => IpcError::Io {
                message: e.to_string(),
            },
            EngineError::InvalidArgument(message) | EngineError::ReplayEncode(message) => {
                IpcError::Internal { message }
            }
        }
    }
}

impl From<std::io::Error> for IpcError {
    fn from(e: std::io::Error) -> IpcError {
        IpcError::Io {
            message: e.to_string(),
        }
    }
}

/// editor commands surface engine validation as InvalidEdit -- a rejected
/// edit is a normal, user-visible outcome there, where for a load the same
/// error is an internal precondition failure
pub fn editor_engine_error(e: EngineError) -> IpcError {
    match e {
        EngineError::InvalidArgument(message) => IpcError::InvalidEdit { message },
        other => IpcError::from(other),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Warning {
    AudioMissing,
    ModsNotSimulated {
        mods: u32,
    },
    BeatmapMismatch {
        expected_md5: String,
        actual_md5: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::EngineError;
    use serde_json::json;

    #[test]
    fn engine_errors_map_onto_the_ipc_union() {
        assert_eq!(
            IpcError::from(EngineError::BeatmapParse("bad".into())),
            IpcError::BeatmapParse {
                message: "bad".into()
            }
        );
        assert_eq!(
            IpcError::from(EngineError::ReplayParse("bad".into())),
            IpcError::ReplayParse {
                message: "bad".into()
            }
        );
        assert_eq!(
            IpcError::from(EngineError::ResourceLimit {
                cap: "MAX_OSR_FILE_BYTES",
                limit: 4,
                actual: 5
            }),
            IpcError::ResourceLimit {
                cap: "MAX_OSR_FILE_BYTES".into(),
                limit: 4,
                actual: 5
            }
        );
        assert_eq!(
            IpcError::from(EngineError::UnsupportedMode(engine::formats::GameMode::Taiko)),
            IpcError::UnsupportedMode { mode: "Taiko".into() }
        );
        // encode-side and precondition failures cannot legitimately surface
        // from a load; they fold into Internal rather than misreporting as a
        // parse failure
        assert_eq!(
            IpcError::from(EngineError::InvalidArgument("x".into())),
            IpcError::Internal { message: "x".into() }
        );
        assert_eq!(
            IpcError::from(EngineError::ReplayEncode("x".into())),
            IpcError::Internal { message: "x".into() }
        );
        assert!(matches!(
            IpcError::from(EngineError::Io(std::io::Error::other("io"))),
            IpcError::Io { .. }
        ));
    }

    #[test]
    fn errors_serialize_kind_tagged_camel_case() {
        let e = IpcError::BeatmapNotFound { md5: "abc".into() };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({ "kind": "beatmapNotFound", "md5": "abc" })
        );

        let e = IpcError::BeatmapMismatch {
            expected_md5: "a".into(),
            actual_md5: "b".into(),
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({ "kind": "beatmapMismatch", "expectedMd5": "a", "actualMd5": "b" })
        );

        let e = IpcError::ResourceLimit {
            cap: "MAX_OSZ_ENTRIES".into(),
            limit: 1,
            actual: 2,
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({ "kind": "resourceLimit", "cap": "MAX_OSZ_ENTRIES", "limit": 1, "actual": 2 })
        );
    }

    #[test]
    fn warnings_serialize_kind_tagged_camel_case() {
        assert_eq!(
            serde_json::to_value(Warning::AudioMissing).unwrap(),
            json!({ "kind": "audioMissing" })
        );
        assert_eq!(
            serde_json::to_value(Warning::ModsNotSimulated { mods: 8 }).unwrap(),
            json!({ "kind": "modsNotSimulated", "mods": 8 })
        );
        assert_eq!(
            serde_json::to_value(Warning::BeatmapMismatch {
                expected_md5: "a".into(),
                actual_md5: "b".into()
            })
            .unwrap(),
            json!({ "kind": "beatmapMismatch", "expectedMd5": "a", "actualMd5": "b" })
        );
    }

    #[test]
    fn editor_error_kinds_serialize_camel_case() {
        let v = serde_json::to_value(IpcError::InvalidEdit {
            message: "bad".into(),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "invalidEdit", "message": "bad" }));
        let v = serde_json::to_value(IpcError::StaleSession).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "staleSession" }));
        let v = serde_json::to_value(IpcError::NotEditable { reason: "why".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "notEditable", "reason": "why" }));
    }

    #[test]
    fn export_error_kinds_serialize_camel_case() {
        let v = serde_json::to_value(IpcError::FileExists {
            path: r"C:\x.osr".into(),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "fileExists", "path": r"C:\x.osr" }));
        let v = serde_json::to_value(IpcError::ExportOverflow {
            field: "maxCombo".into(),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "exportOverflow", "field": "maxCombo" }));
    }

    #[test]
    fn editor_commands_map_invalid_argument_to_invalid_edit() {
        let mapped = editor_engine_error(engine::EngineError::InvalidArgument("nope".into()));
        assert_eq!(
            mapped,
            IpcError::InvalidEdit {
                message: "nope".into()
            }
        );
        // every other engine error keeps the blanket mapping
        let mapped = editor_engine_error(engine::EngineError::ResourceLimit {
            cap: "MAX_EDIT_BATCH_MEMBERS",
            limit: 1,
            actual: 2,
        });
        assert!(matches!(mapped, IpcError::ResourceLimit { .. }));
    }
}
