import Foundation

/// Every user-visible string in the app resolves through here.
///
/// The strings ship as `en.lproj` and `zh-Hans.lproj` inside the assembled app's
/// `Contents/Resources`, which makes `Bundle.main` the bundle that holds them.
/// Naming it at each lookup is deliberate: `Text("…")` would resolve a
/// `LocalizedStringKey` against `Bundle.main` on its own, but `Theme` and
/// `BoardModel` hand plain `String`s to callers that are not views at all, and a
/// SwiftPM resource bundle would answer to `Bundle.module` instead. One function
/// keeps view and non-view code on the same bundle, so there is no way for half the
/// interface to translate and the other half to stay behind.
///
/// A missing table makes this return the key itself, which is loud on purpose: the
/// app is only ever run from the bundle `Scripts/bundle.sh` assembles, so raw keys
/// on screen mean the localizations did not get copied in.
func loc(_ key: String) -> String {
    Bundle.main.localizedString(forKey: key, value: key, table: nil)
}

/// Format variant, for the strings that carry a count or an interpolated value.
///
/// `locale:` is doing two jobs. It resolves the `%#@…@` tokens that come out of
/// `Localizable.stringsdict`, which a plain `String(format:)` leaves in place, and
/// it decides which plural rule applies. That locale has to follow the language the
/// bundle actually picked rather than `Locale.current`: a user whose Mac is set to
/// Chinese and who launches this app in English would otherwise get English words
/// selected by Chinese plural rules, and "1 layers" on screen.
func loc(_ key: String, _ arguments: CVarArg...) -> String {
    String(format: loc(key), locale: localizationLocale, arguments: arguments)
}

/// The language the bundle resolved to. Fixed for the life of the process, because
/// the search list is read once at launch.
private let localizationLocale = Locale(
    identifier: Bundle.main.preferredLocalizations.first ?? "en"
)
