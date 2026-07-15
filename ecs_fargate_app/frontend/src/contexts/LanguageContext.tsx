import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Language, i18nStrings, I18nStrings } from '../i18n/strings';
import { 
  SUPPORTED_LANGUAGES, 
  isValidLanguage, 
  getDefaultLanguage 
} from '../i18n/languages';

interface LanguageContextType {
  language: Language;
  setLanguage: (language: Language) => void;
  strings: I18nStrings;
  getString: (category: keyof I18nStrings, key: string) => string;
  getNestedString: (category: keyof I18nStrings, subcategory: string, key: string) => string;
  supportedLanguages: typeof SUPPORTED_LANGUAGES;
  getLanguageNativeName: (code: string) => string;
  getLanguageName: (code: string) => string;
  getSwitchToLanguageText: (targetLangCode: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

interface LanguageProviderProps {
  children: ReactNode;
}

const LANGUAGE_STORAGE_KEY = 'wa-analyzer-language';

export const LanguageProvider: React.FC<LanguageProviderProps> = ({ children }) => {
  // Initialize language from localStorage or default to getDefaultLanguage()
  const [language, setLanguageState] = useState<Language>(() => {
    try {
      // First try the context's dedicated storage key
      const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (stored && isValidLanguage(stored)) {
        return stored;
      }

      // Then try the component's localStorage key for backwards compatibility
      const preferredLanguage = localStorage.getItem('preferredLanguage');
      if (preferredLanguage && isValidLanguage(preferredLanguage)) {
        return preferredLanguage;
      }

      return getDefaultLanguage();
    } catch {
      return getDefaultLanguage();
    }
  });

  // Update localStorage when language changes
  useEffect(() => {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch (error) {
      console.warn('Failed to save language preference:', error);
    }
  }, [language]);

  const setLanguage = (newLanguage: Language) => {
    if (isValidLanguage(newLanguage)) {
      setLanguageState(newLanguage);
    } else {
      console.warn(`Invalid language code: ${newLanguage}. Using default language.`);
      setLanguageState(getDefaultLanguage());
    }
  };

  const strings = i18nStrings[language];

  // Helper function to get string from a category
  const getString = (category: keyof I18nStrings, key: string): string => {
    const categoryStrings = strings[category] as any;
    if (categoryStrings && typeof categoryStrings[key] === 'string') {
      return categoryStrings[key];
    }

    // Fallback to English if string not found
    const fallbackStrings = i18nStrings.en[category] as any;
    if (fallbackStrings && typeof fallbackStrings[key] === 'string') {
      return fallbackStrings[key];
    }

    return key; // Return key as fallback
  };

  // Helper function to get nested string (e.g., app.navigation.sideNavigation)
  const getNestedString = (category: keyof I18nStrings, subcategory: string, key: string): string => {
    const categoryStrings = strings[category] as any;
    if (categoryStrings && categoryStrings[subcategory] && typeof categoryStrings[subcategory][key] === 'string') {
      return categoryStrings[subcategory][key];
    }

    // Fallback to English if string not found
    const fallbackStrings = i18nStrings.en[category] as any;
    if (fallbackStrings && fallbackStrings[subcategory] && typeof fallbackStrings[subcategory][key] === 'string') {
      return fallbackStrings[subcategory][key];
    }

    return key; // Return key as fallback
  };

  const getLanguageNativeName = (code: string): string => {
    const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
    return lang?.nativeName || code;
  };
  
  const getLanguageName = (code: string): string => {
    const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
    return lang?.label || code;
  };
  
  // Format the "Switch to X" text using the current language's format string
  const getSwitchToLanguageText = (targetLangCode: string): string => {
    const targetLang = SUPPORTED_LANGUAGES.find(l => l.code === targetLangCode);
    if (!targetLang) return '';
    
    // Use the switchTo format string from the current language
    return strings.language.switchTo.replace('{language}', targetLang.nativeName);
  };

  const value: LanguageContextType = {
    language,
    setLanguage,
    strings,
    getString,
    getNestedString,
    supportedLanguages: SUPPORTED_LANGUAGES,
    getLanguageNativeName,
    getLanguageName,
    getSwitchToLanguageText,
  };

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};

// Convenience hooks for common use cases
export const useStrings = () => {
  const { strings } = useLanguage();
  return strings;
};

export const useCurrentLanguage = () => {
  const { language } = useLanguage();
  return language;
};
